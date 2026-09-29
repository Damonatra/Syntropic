# syntropic/api/main.py

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Dict, Any, Literal, Optional
import shutil
from pathlib import Path
import uuid
from functools import lru_cache
import json
import sqlite3
from pypdf import PdfReader

from syntropic.core.engine import build_syntropic_engine, erp_push_node

app = FastAPI(
    title="Syntropic Enterprise Engine API",
    version="1.0.0",
    description="Asynchronous RFQ Document Parsing & Catalog Matching Pipeline"
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
UPLOAD_DIR = Path("outputs/uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
REVIEW_DB_PATH = Path("outputs/review_queue.sqlite3")

class ProcessingResponse(BaseModel):
    job_id: str
    status: str
    filename: str
    execution_result: Optional[Dict[str, Any]] = None
    review_decision: Optional[Literal["approve", "reject"]] = None
    review_note: Optional[str] = None


class ReviewRequest(BaseModel):
    decision: Literal["approve", "reject"]
    part_number: Optional[str] = Field(default=None, min_length=1, max_length=100)
    quantity: Optional[int] = Field(default=None, ge=1)
    note: Optional[str] = Field(default=None, max_length=1000)


class ReviewQueueItem(BaseModel):
    job_id: str
    filename: str


@lru_cache(maxsize=1)
def _get_graph_app():
    return build_syntropic_engine()


def _status_from_final_state(final_state: Dict[str, Any]) -> str:
    execution_log = final_state.get("execution_log", [])
    if any(log.startswith("Flagged for Human Review:") for log in execution_log):
        return "flagged_for_review"
    return "completed"


def _connect_review_store() -> sqlite3.Connection:
    REVIEW_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(REVIEW_DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """CREATE TABLE IF NOT EXISTS rfq_jobs (
            job_id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            status TEXT NOT NULL,
            execution_result TEXT NOT NULL,
            review_decision TEXT,
            review_note TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    connection.commit()
    return connection


def _save_review_job(
    job_id: str,
    filename: str,
    status: str,
    execution_result: Dict[str, Any],
    review_decision: Optional[str] = None,
    review_note: Optional[str] = None,
) -> None:
    connection = _connect_review_store()
    try:
        connection.execute(
            """INSERT INTO rfq_jobs (
                job_id, filename, status, execution_result, review_decision, review_note
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_id) DO UPDATE SET
                filename = excluded.filename,
                status = excluded.status,
                execution_result = excluded.execution_result,
                review_decision = excluded.review_decision,
                review_note = excluded.review_note,
                updated_at = CURRENT_TIMESTAMP""",
            (
                job_id,
                filename,
                status,
                json.dumps(execution_result),
                review_decision,
                review_note,
            ),
        )
        connection.commit()
    finally:
        connection.close()


def _get_review_job(job_id: str) -> Optional[Dict[str, Any]]:
    connection = _connect_review_store()
    try:
        row = connection.execute(
            "SELECT * FROM rfq_jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
    finally:
        connection.close()

    if row is None:
        return None
    job = dict(row)
    job["execution_result"] = json.loads(job["execution_result"])
    return job


def _list_pending_review_jobs() -> list[Dict[str, str]]:
    connection = _connect_review_store()
    try:
        rows = connection.execute(
            "SELECT job_id, filename FROM rfq_jobs WHERE status = ? ORDER BY created_at",
            ("flagged_for_review",),
        ).fetchall()
    finally:
        connection.close()
    return [dict(row) for row in rows]


@app.get("/health")
def health_check():
    return {"status": "online", "engine": "Syntropic Core 1.0"}


@app.get("/api/v1/rfq/reviews", response_model=list[ReviewQueueItem])
def list_pending_reviews():
    return _list_pending_review_jobs()


@app.get("/api/v1/rfq/reviews/{job_id}", response_model=ProcessingResponse)
def get_review_job(job_id: str):
    job = _get_review_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="RFQ job not found.")
    return job


@app.post("/api/v1/rfq/{job_id}/review", response_model=ProcessingResponse)
def review_rfq(job_id: str, review: ReviewRequest):
    job = _get_review_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="RFQ job not found.")
    if job["status"] != "flagged_for_review":
        raise HTTPException(status_code=409, detail="RFQ job is not awaiting review.")

    execution_result = dict(job["execution_result"])
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
        if review.part_number is not None:
            extracted_data["part_number"] = review.part_number.strip()
        if review.quantity is not None:
            extracted_data["quantity"] = review.quantity
        if not extracted_data.get("part_number") or not extracted_data.get("quantity"):
            raise HTTPException(
                status_code=422,
                detail="Approval requires a part number and positive quantity.",
            )
        if not str(extracted_data["part_number"]).strip():
            raise HTTPException(status_code=422, detail="Part number cannot be blank.")

        matched_item = execution_result.get("matched_catalog_item")
        if matched_item and str(matched_item.get("part_number", "")).upper() != str(
            extracted_data["part_number"]
        ).strip().upper():
            matched_item = None

        execution_result.update(
            {
                "extracted_data": extracted_data,
                "confidence_score": 1.0,
                "validation_errors": [],
                "matched_catalog_item": matched_item,
                "catalog_match_score": execution_result.get("catalog_match_score", 0.0)
                if matched_item
                else 0.0,
            }
        )
        execution_result["execution_log"] = list(execution_result.get("execution_log", []))
        execution_result["execution_log"].append(
            f"Human reviewer approved corrected fields for {extracted_data['part_number']}."
        )
        try:
            execution_result["execution_log"].extend(
                erp_push_node(execution_result).get("execution_log", [])
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        status = "completed"
        note = (review.note or "").strip()

    _save_review_job(
        job_id,
        job["filename"],
        status,
        execution_result,
        review.decision,
        note or None,
    )
    return ProcessingResponse(
        job_id=job_id,
        status=status,
        filename=job["filename"],
        execution_result=execution_result,
        review_decision=review.decision,
        review_note=note or None,
    )


@app.post("/api/v1/rfq/process", response_model=ProcessingResponse)
async def process_rfq_document(file: UploadFile = File(...)):
    """
    Inbound RFQ PDF endpoint. Extractable PDF text is passed to the
    labeled-field extraction, catalog matching, and review workflow.
    """
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    job_id = str(uuid.uuid4())
    saved_path = UPLOAD_DIR / f"{job_id}_{file.filename}"

    # Save uploaded file safely
    with open(saved_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        pdf_text = "\n".join(page.extract_text() or "" for page in PdfReader(saved_path).pages)

        # Initialize execution state
        initial_state = {
            "raw_input": pdf_text,
            "extracted_data": {},
            "confidence_score": 0.0,
            "validation_errors": [],
            "retry_count": 0,
            "execution_log": [f"File uploaded: {file.filename}"]
        }

        # Invoke the complete LangGraph Syntropic engine
        final_state = _get_graph_app().invoke(initial_state)
        status = _status_from_final_state(final_state)
        _save_review_job(job_id, file.filename, status, final_state)

        return ProcessingResponse(
            job_id=job_id,
            status=status,
            filename=file.filename,
            execution_result=final_state
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Pipeline processing error: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("syntropic.core.matching.api.main:app", host="127.0.0.1", port=8000, reload=True)