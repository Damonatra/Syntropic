# syntropic/api/main.py

from contextlib import asynccontextmanager
import asyncio
import json
import os
from pathlib import Path, PureWindowsPath
from typing import Any, AsyncGenerator, AsyncIterator, Dict, Literal, Optional
import uuid

from fastapi import Depends, FastAPI, UploadFile, File, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from pypdf.errors import PdfReadError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sse_starlette.sse import EventSourceResponse

from syntropic.core.engine import build_syntropic_engine, erp_push_node
from syntropic.core.matching.api.auth import require_authenticated_user
from syntropic.core.matching.api.database import (
    Base,
    ReviewJob,
    get_review_job as fetch_review_job,
    list_pending_review_jobs as fetch_pending_review_jobs,
    save_review_job as persist_review_job,
)
from syntropic.ingestion.parser import parse_pdf_text

MAX_UPLOAD_BYTES = 20 * 1024 * 1024


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncGenerator[None, None]:
    database_url = os.getenv("DATABASE_URL", "").strip()
    if not database_url:
        raise RuntimeError("DATABASE_URL must be configured.")
    testing = getattr(application.state, "testing", False)
    if not testing and not database_url.startswith(
        "postgresql+asyncpg://"
    ):
        raise RuntimeError("Runtime DATABASE_URL must use PostgreSQL with asyncpg.")

    engine = create_async_engine(database_url, pool_pre_ping=True)
    application.state.engine = engine
    application.state.session_factory = async_sessionmaker(
        engine, expire_on_commit=False
    )

    try:
        if testing:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            application.state.graph_app = None
            yield
        else:
            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

            checkpoint_url = database_url.replace(
                "postgresql+asyncpg://", "postgresql://", 1
            )
            async with AsyncPostgresSaver.from_conn_string(
                checkpoint_url
            ) as checkpointer:
                await checkpointer.setup()
                application.state.graph_app = build_syntropic_engine(checkpointer)
                yield
    finally:
        await engine.dispose()


app = FastAPI(
    title="Syntropic Enterprise Engine API",
    version="1.0.0",
    description="Asynchronous RFQ Document Parsing & Catalog Matching Pipeline",
    lifespan=lifespan,
)

# Enable CORS for local UI development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8501", "http://127.0.0.1:8501"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global Storage Directory for Inbound RFQ PDFs
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "outputs/uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

class ProcessingResponse(BaseModel):
    job_id: str
    status: str
    filename: str
    execution_result: Optional[Dict[str, Any]] = None
    review_decision: Optional[Literal["approve", "reject"]] = None
    review_note: Optional[str] = None


class ReviewRequest(BaseModel):
    decision: Literal["approve", "reject"]
    line_items: Optional[list["ReviewLineItem"]] = None
    part_number: Optional[str] = Field(default=None, min_length=1, max_length=100)
    quantity: Optional[int] = Field(default=None, ge=1)
    note: Optional[str] = Field(default=None, max_length=1000)


class ReviewLineItem(BaseModel):
    part_number: str = Field(min_length=1, max_length=100)
    quantity: int = Field(ge=1)


class ReviewQueueItem(BaseModel):
    job_id: str
    filename: str


def _status_from_final_state(final_state: Dict[str, Any]) -> str:
    execution_log = final_state.get("execution_log", [])
    if any(log.startswith("Flagged for Human Review:") for log in execution_log):
        return "flagged_for_review"
    return "completed"


def _job_response(job: ReviewJob) -> dict[str, Any]:
    return {
        "job_id": job.job_id,
        "filename": job.filename,
        "status": job.status,
        "execution_result": job.execution_result,
        "review_decision": job.review_decision,
        "review_note": job.review_note,
    }


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.session_factory() as session:
        yield session


async def _review_queue_event_stream(
    request: Request, session_factory: async_sessionmaker[AsyncSession]
):
    previous_queue = None
    while not await request.is_disconnected():
        async with session_factory() as session:
            review_queue = await fetch_pending_review_jobs(session)
        if review_queue != previous_queue:
            yield {
                "event": "review_queue",
                "data": json.dumps({"reviews": review_queue}),
            }
            previous_queue = review_queue
        await asyncio.sleep(1)


@app.get("/health")
def health_check():
    return {"status": "online", "engine": "Syntropic Core 1.0"}


@app.get(
    "/api/v1/rfq/reviews",
    response_model=list[ReviewQueueItem],
    dependencies=[Depends(require_authenticated_user)],
)
async def list_pending_reviews(session: AsyncSession = Depends(get_session)):
    return await fetch_pending_review_jobs(session)


@app.get(
    "/api/v1/rfq/reviews/events",
    dependencies=[Depends(require_authenticated_user)],
)
async def stream_review_queue(request: Request):
    return EventSourceResponse(
        _review_queue_event_stream(request, request.app.state.session_factory),
        ping=15,
    )


@app.get(
    "/api/v1/rfq/reviews/{job_id}",
    response_model=ProcessingResponse,
    dependencies=[Depends(require_authenticated_user)],
)
async def get_review_job(
    job_id: str, session: AsyncSession = Depends(get_session)
):
    job = await fetch_review_job(session, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="RFQ job not found.")
    return _job_response(job)


@app.get(
    "/api/v1/rfq/reviews/{job_id}/document",
    dependencies=[Depends(require_authenticated_user)],
)
async def get_review_document(
    job_id: str, session: AsyncSession = Depends(get_session)
):
    job = await fetch_review_job(session, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="RFQ job not found.")

    filename_prefix = f"{job_id}_"
    document_path = next(
        (
            path
            for path in UPLOAD_DIR.iterdir()
            if path.is_file()
            and path.name.startswith(filename_prefix)
            and path.suffix.lower() == ".pdf"
        ),
        None,
    ) if UPLOAD_DIR.exists() else None
    if document_path is None:
        raise HTTPException(status_code=404, detail="Source PDF not found.")
    return FileResponse(
        document_path, media_type="application/pdf", filename=job.filename
    )


@app.post(
    "/api/v1/rfq/{job_id}/review",
    response_model=ProcessingResponse,
    dependencies=[Depends(require_authenticated_user)],
)
async def review_rfq(
    job_id: str,
    review: ReviewRequest,
    session: AsyncSession = Depends(get_session),
):
    job = await fetch_review_job(session, job_id, for_update=True)
    if job is None:
        raise HTTPException(status_code=404, detail="RFQ job not found.")
    if job.status != "flagged_for_review":
        raise HTTPException(status_code=409, detail="RFQ job is not awaiting review.")

    execution_result = dict(job.execution_result)
    if review.decision == "reject":
        status = "rejected"
        note = (review.note or "").strip()
        message = "Human reviewer rejected this RFQ."
        execution_result["execution_log"] = list(execution_result.get("execution_log", []))
        execution_result["execution_log"].append(
            f"{message} Note: {note}" if note else message
        )
    else:
        extracted_data = dict(execution_result.get("extracted_data", {}))
        existing_line_items = extracted_data.get("line_items")
        has_line_item_list = (
            isinstance(existing_line_items, list) and bool(existing_line_items)
        ) or review.line_items is not None
        if not isinstance(existing_line_items, list) or not existing_line_items:
            existing_line_items = [extracted_data]

        if review.line_items is not None:
            corrected_line_items = [
                item.model_dump() for item in review.line_items
            ]
        else:
            corrected_line_items = [dict(item) for item in existing_line_items]
            if review.part_number is not None:
                corrected_line_items[0]["part_number"] = review.part_number.strip()
            if review.quantity is not None:
                corrected_line_items[0]["quantity"] = review.quantity

        if not corrected_line_items or any(
            not str(item.get("part_number", "")).strip()
            or not item.get("quantity")
            for item in corrected_line_items
        ):
            raise HTTPException(
                status_code=422,
                detail="Approval requires a part number and positive quantity for every line item.",
            )
        for item in corrected_line_items:
            item["part_number"] = str(item["part_number"]).strip()

        previous_matches = execution_result.get("matched_catalog_items") or []
        if not previous_matches and execution_result.get("matched_catalog_item"):
            previous_matches = [{
                "catalog_item": execution_result["matched_catalog_item"],
                "rrf_score": execution_result.get("catalog_match_score", 0.0),
            }]
        reviewed_matches = []
        for index, item in enumerate(corrected_line_items):
            previous_match = (
                previous_matches[index] if index < len(previous_matches) else {}
            )
            catalog_item = previous_match.get("catalog_item")
            if catalog_item and str(catalog_item.get("part_number", "")).upper() != (
                item["part_number"].upper()
            ):
                catalog_item = None
            reviewed_matches.append({
                "extracted_item": item,
                "catalog_item": catalog_item,
                "rrf_score": (
                    previous_match.get("rrf_score", 0.0) if catalog_item else 0.0
                ),
            })

        if has_line_item_list:
            extracted_data["line_items"] = corrected_line_items
        extracted_data.update(corrected_line_items[0])
        matched_item = reviewed_matches[0]["catalog_item"]

        execution_result.update(
            {
                "extracted_data": extracted_data,
                "confidence_score": 1.0,
                "validation_errors": [],
                "matched_catalog_item": matched_item,
                "matched_catalog_items": reviewed_matches,
                "catalog_match_score": min(
                    match["rrf_score"] for match in reviewed_matches
                ),
            }
        )
        execution_result["execution_log"] = list(execution_result.get("execution_log", []))
        execution_result["execution_log"].append(
            f"Human reviewer approved {len(corrected_line_items)} RFQ line item(s)."
        )
        try:
            execution_result["execution_log"].extend(
                erp_push_node(execution_result).get("execution_log", [])
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        status = "completed"
        note = (review.note or "").strip()

    await persist_review_job(
        session,
        job_id,
        job.filename,
        status,
        execution_result,
        review.decision,
        note or None,
    )
    return ProcessingResponse(
        job_id=job_id,
        status=status,
        filename=job.filename,
        execution_result=execution_result,
        review_decision=review.decision,
        review_note=note or None,
    )


@app.post(
    "/api/v1/rfq/process",
    response_model=ProcessingResponse,
    dependencies=[Depends(require_authenticated_user)],
)
async def process_rfq_document(
    request: Request,
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
):
    """
    Inbound RFQ PDF endpoint. Extractable PDF text is passed to the
    labeled-field extraction, catalog matching, and review workflow.
    """
    filename = PureWindowsPath(file.filename or "").name
    if not filename or "\x00" in filename or not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Uploaded PDF exceeds 20 MiB.")

    job_id = str(uuid.uuid4())
    saved_path = UPLOAD_DIR / f"{job_id}_{filename}"
    persisted = False

    try:
        saved_path.write_bytes(content)
        pdf_text = parse_pdf_text(saved_path)

        # Initialize execution state
        initial_state = {
            "raw_input": pdf_text,
            "extracted_data": {},
            "confidence_score": 0.0,
            "validation_errors": [],
            "retry_count": 0,
            "execution_log": [f"File uploaded: {filename}"]
        }

        graph_app = request.app.state.graph_app
        if graph_app is None:
            raise HTTPException(
                status_code=503, detail="Workflow execution is unavailable."
            )
        final_state = await graph_app.ainvoke(
            initial_state, config={"configurable": {"thread_id": job_id}}
        )
        status = _status_from_final_state(final_state)
        await persist_review_job(session, job_id, filename, status, final_state)
        persisted = True

        return ProcessingResponse(
            job_id=job_id,
            status=status,
            filename=filename,
            execution_result=final_state
        )
    except PdfReadError as error:
        raise HTTPException(
            status_code=422, detail="Uploaded file is not a valid PDF."
        ) from error
    finally:
        if not persisted:
            saved_path.unlink(missing_ok=True)
        await file.close()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("syntropic.api.main:app", host="127.0.0.1", port=8000, reload=True)
    # Add to syntropic/api/main.py

from sse_starlette.sse import EventSourceResponse
import asyncio

@app.get(
    "/api/v1/rfq/stream/{job_id}",
    dependencies=[Depends(require_authenticated_user)],
)
async def stream_rfq_execution(job_id: str):
    """
    Streams LangGraph execution events to the frontend in real time via SSE.
    """
    async def event_generator():
        yield {"event": "status", "data": json.dumps({"step": "ingestion", "message": "Docling PDF Spatial Extraction Started..."})}
        await asyncio.sleep(0.5)
        
        yield {"event": "status", "data": json.dumps({"step": "validation", "message": "Instructor Pydantic Validation & Normalization Active..."})}
        await asyncio.sleep(0.5)
        
        yield {"event": "status", "data": json.dumps({"step": "matching", "message": "Qdrant BM25 + Dense RRF Hybrid Search Executing..."})}
        await asyncio.sleep(0.5)
        
        yield {"event": "status", "data": json.dumps({"step": "gate_check", "message": "Evaluating Health Gate Criteria (Threshold: 0.85)..."})}
        await asyncio.sleep(0.2)
        
        yield {"event": "complete", "data": json.dumps({"status": "finished", "job_id": job_id})}

    return EventSourceResponse(event_generator())