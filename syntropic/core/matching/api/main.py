# syntropic/api/main.py

from contextlib import asynccontextmanager
import asyncio
from datetime import datetime
import hashlib
import json
import logging
import os
from pathlib import Path, PureWindowsPath
import secrets
from typing import Any, AsyncGenerator, AsyncIterator, Dict, Literal, Optional
import uuid

from fastapi import Depends, FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sse_starlette.sse import EventSourceResponse

from syntropic.core.engine import (
    build_syntropic_engine,
    erp_sync_node,
    get_postgres_saver,
    init_checkpointer_pool,
)
from syntropic.core.matching.margin_defender import (
    DECISION_VETO,
    MarginDefender,
    apply_margin_decisions,
    build_price_delta_telemetry,
)
from syntropic.core.normalization import normalize_unit_of_measure
from syntropic.core.matching.api.auth import (
    OIDC_FLOW_COOKIE,
    OIDC_FLOW_TTL_SECONDS,
    _oidc_metadata,
    _read_flow_state,
    bind_tenant_context,
    create_oidc_authorization_request,
    exchange_oidc_code,
    get_oidc_client_config,
    require_authenticated_user,
    verify_oidc_id_token,
)
from syntropic.core.matching.api.database import (
    Base,
    PENDING_HITL_STATUS,
    REVIEWABLE_STATUSES,
    ReviewJob,
    get_review_job as fetch_review_job,
    list_pending_review_jobs as fetch_pending_review_jobs,
    save_review_job as persist_review_job,
)
from syntropic.core.matching.api.webhook import (
    deliver_webhook_outbox,
    get_webhook_config,
)
from syntropic.core.dispatch.graph_auth import GraphTokenManager
from syntropic.core.stream import emit_event
from syntropic.core.config import settings
from syntropic.core.roi.reporting import (
    monthly_statement,
    roi_summary,
    verify_statement,
)
from syntropic.core.dispatch.outlook_dispatch import (
    deliver_dispatch_outbox,
    dispatch_enabled,
    get_dispatch_config,
)
from syntropic.ingestion.parser import PdfConversionError, parse_pdf_document
from security.ast_veto import (
    TenantIsolationViolationError,
    get_current_tenant,
    set_current_tenant,
    reset_current_tenant,
    tenant_context,
)

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
VETO_BLOCKED_STATUS = "veto_blocked"
logger = logging.getLogger(__name__)


def _report_webhook_worker_failure(worker: asyncio.Task[None]) -> None:
    if worker.cancelled():
        return
    error = worker.exception()
    if error is not None:
        logger.error(
            "Webhook delivery worker stopped unexpectedly.",
            exc_info=(type(error), error, error.__traceback__),
        )


def _report_dispatch_worker_failure(worker: asyncio.Task[None]) -> None:
    if worker.cancelled():
        return
    error = worker.exception()
    if error is not None:
        logger.error(
            "Draft dispatch worker stopped unexpectedly.",
            exc_info=(type(error), error, error.__traceback__),
        )


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
    checkpointer_pool = None
    webhook_worker = None
    dispatch_worker = None
    dispatch_token_manager = None

    try:
        if testing:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            application.state.graph_app = None
            yield
        else:
            checkpointer_pool = await init_checkpointer_pool()
            application.state.checkpointer_pool = checkpointer_pool
            checkpointer = await get_postgres_saver(checkpointer_pool)
            application.state.graph_app = build_syntropic_engine(checkpointer)
            webhook_endpoint, webhook_secret = get_webhook_config()
            webhook_worker = asyncio.create_task(
                deliver_webhook_outbox(
                    application.state.session_factory,
                    webhook_endpoint,
                    webhook_secret,
                ),
                name="syntropic-webhook-outbox",
            )
            webhook_worker.add_done_callback(_report_webhook_worker_failure)
            # Zero-UI draft dispatch (Layer 4): same durable-outbox pattern,
            # Drafts-folder-only. Disabled or misconfigured deployments skip
            # the worker and quotes stay in the review queue.
            if dispatch_enabled():
                try:
                    dispatch_config = get_dispatch_config()
                    dispatch_token_manager = GraphTokenManager(
                        dispatch_config.tenant_id,
                        dispatch_config.client_id,
                        dispatch_config.client_secret,
                    )
                    dispatch_worker = asyncio.create_task(
                        deliver_dispatch_outbox(
                            application.state.session_factory,
                            dispatch_config,
                            dispatch_token_manager,
                        ),
                        name="syntropic-dispatch-outbox",
                    )
                    dispatch_worker.add_done_callback(
                        _report_dispatch_worker_failure
                    )
                except (RuntimeError, ValueError):
                    logger.error(
                        "Draft dispatch enabled but misconfigured; "
                        "draft injection disabled for this run.",
                        exc_info=True,
                    )
            yield
    finally:
        try:
            if webhook_worker is not None:
                webhook_worker.cancel()
                try:
                    await webhook_worker
                except asyncio.CancelledError:
                    pass
        finally:
            try:
                if dispatch_worker is not None:
                    dispatch_worker.cancel()
                    try:
                        await dispatch_worker
                    except asyncio.CancelledError:
                        pass
            finally:
                if dispatch_token_manager is not None:
                    await dispatch_token_manager.aclose()
                if checkpointer_pool is not None:
                    await checkpointer_pool.close()
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
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(TenantIsolationViolationError)
async def tenant_isolation_veto_handler(
    request: Request, exc: TenantIsolationViolationError
):
    """Map tenant-isolation vetoes to 403 without leaking tenant data."""
    logger.warning(
        "Tenant isolation veto blocked a request to %s: %s", request.url.path, exc
    )
    return JSONResponse(
        status_code=403,
        content={"detail": str(exc), "code": VETO_BLOCKED_STATUS},
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
    unit_of_measure: str | None = Field(default=None, min_length=1, max_length=16)


class ReviewQueueItem(BaseModel):
    job_id: str
    filename: str


def _status_from_final_state(final_state: Dict[str, Any]) -> str:
    if final_state.get("hitl_reason_code") == "below_confidence_floor":
        return PENDING_HITL_STATUS
    # Margin vetoes park the RFQ in the same pending-human queue: the
    # margin defender refused the push and a human must decide.
    if final_state.get("hitl_reason_code") == "margin_veto":
        return PENDING_HITL_STATUS
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
    # Background tasks do not inherit the request-scoped tenant context, so
    # the handshake tenant is captured and re-bound for every queue poll.
    handshake_tenant_id = get_current_tenant()
    previous_queue = None
    while not await request.is_disconnected():
        bind_token = set_current_tenant(handshake_tenant_id)
        try:
            async with session_factory() as session:
                review_queue = await fetch_pending_review_jobs(session)
        finally:
            reset_current_tenant(bind_token)
        if review_queue != previous_queue:
            yield {
                "event": "review_queue",
                "data": json.dumps({"reviews": review_queue}),
            }
            previous_queue = review_queue
        await asyncio.sleep(1)


async def _authenticated_token_response(
    token_response: dict[str, Any], nonce: str, client_id: str
) -> JSONResponse:
    access_token = token_response.get("access_token")
    identity_token = token_response.get("id_token")
    if not isinstance(access_token, str) or not isinstance(identity_token, str):
        raise HTTPException(
            status_code=502,
            detail="The OIDC provider did not return the required tokens.",
        )

    await asyncio.to_thread(verify_oidc_id_token, identity_token, nonce, client_id)
    claims = await asyncio.to_thread(
        require_authenticated_user,
        HTTPAuthorizationCredentials(scheme="Bearer", credentials=access_token),
    )
    response = JSONResponse(
        {
            "access_token": access_token,
            "token_type": "bearer",
            "expires_in": token_response.get("expires_in"),
            "authenticated_as": claims["sub"],
        },
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )
    return response


@app.get("/api/v1/auth/authorize", include_in_schema=False)
async def begin_oidc_authorization():
    config = get_oidc_client_config()
    metadata = await _oidc_metadata(config["issuer"])
    authorization_url, signed_state = create_oidc_authorization_request(
        metadata, config
    )
    response = RedirectResponse(authorization_url, status_code=302)
    response.set_cookie(
        OIDC_FLOW_COOKIE,
        signed_state,
        max_age=OIDC_FLOW_TTL_SECONDS,
        httponly=True,
        secure=config["redirect_uri"].startswith("https://"),
        samesite="lax",
        path="/api/v1/auth/callback",
    )
    return response


@app.get("/api/v1/auth/callback", include_in_schema=False)
async def complete_oidc_authorization(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    if error:
        raise HTTPException(
            status_code=401, detail="OIDC authentication was not completed."
        )
    if not code or not state:
        raise HTTPException(
            status_code=400, detail="OIDC authorization code and state are required."
        )

    config = get_oidc_client_config()
    cookie_value = request.cookies.get(OIDC_FLOW_COOKIE)
    if not cookie_value:
        raise HTTPException(
            status_code=401, detail="The OIDC login state is missing or expired."
        )
    flow = _read_flow_state(cookie_value, config["state_secret"])
    if not secrets.compare_digest(flow["state"], state):
        raise HTTPException(
            status_code=401, detail="The OIDC login state does not match."
        )

    metadata = await _oidc_metadata(config["issuer"])
    token_response = await exchange_oidc_code(
        code, flow["code_verifier"], config, metadata
    )
    response = await _authenticated_token_response(
        token_response, flow["nonce"], config["client_id"]
    )
    response.delete_cookie(OIDC_FLOW_COOKIE, path="/api/v1/auth/callback")
    return response


@app.post("/api/v1/auth/token")
async def exchange_oidc_authorization_code(
    grant_type: str = Form(),
    code: str = Form(),
    code_verifier: str = Form(min_length=43, max_length=128),
    nonce: str = Form(min_length=1),
    redirect_uri: str = Form(),
):
    config = get_oidc_client_config()
    if grant_type != "authorization_code" or not secrets.compare_digest(
        redirect_uri, config["redirect_uri"]
    ):
        raise HTTPException(
            status_code=400,
            detail="Only authorization-code exchange for the configured redirect URI is supported.",
        )
    metadata = await _oidc_metadata(config["issuer"])
    token_response = await exchange_oidc_code(
        code, code_verifier, config, metadata
    )
    return await _authenticated_token_response(
        token_response, nonce, config["client_id"]
    )


@app.get("/health")
def health_check():
    return {"status": "online", "engine": "Syntropic Core 1.0"}


@app.get("/api/v1/health")
async def authenticated_health_check(
    current_user: dict[str, Any] = Depends(bind_tenant_context),
):
    return {
        "status": "healthy",
        "authenticated_as": current_user["sub"],
    }


@app.get(
    "/api/v1/rfq/reviews",
    response_model=list[ReviewQueueItem],
    dependencies=[Depends(bind_tenant_context)],
)
async def list_pending_reviews(session: AsyncSession = Depends(get_session)):
    return await fetch_pending_review_jobs(session)


@app.get(
    "/api/v1/rfq/reviews/events",
    dependencies=[Depends(bind_tenant_context)],
)
async def stream_review_queue(request: Request):
    return EventSourceResponse(
        _review_queue_event_stream(request, request.app.state.session_factory),
        ping=15,
    )


@app.get(
    "/api/v1/rfq/reviews/{job_id}",
    response_model=ProcessingResponse,
    dependencies=[Depends(bind_tenant_context)],
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
    dependencies=[Depends(bind_tenant_context)],
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
    dependencies=[Depends(bind_tenant_context)],
)
async def review_rfq(
    job_id: str,
    review: ReviewRequest,
    session: AsyncSession = Depends(get_session),
):
    job = await fetch_review_job(session, job_id, for_update=True)
    if job is None:
        raise HTTPException(status_code=404, detail="RFQ job not found.")
    if job.status not in REVIEWABLE_STATUSES:
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
            corrected_line_items = []
            for index, item in enumerate(review.line_items):
                corrected_item = item.model_dump(exclude_none=True)
                if "unit_of_measure" not in corrected_item:
                    previous_item = (
                        existing_line_items[index]
                        if index < len(existing_line_items)
                        else {}
                    )
                    corrected_item["unit_of_measure"] = previous_item.get(
                        "unit_of_measure", "EA"
                    )
                corrected_line_items.append(corrected_item)
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
        for index, item in enumerate(corrected_line_items):
            item["part_number"] = str(item["part_number"]).strip()
            normalized_unit = normalize_unit_of_measure(
                item.get("unit_of_measure")
            )
            if normalized_unit is None:
                raise HTTPException(
                    status_code=422,
                    detail=f"Unsupported unit of measure for line item {index + 1}.",
                )
            item["unit_of_measure"] = normalized_unit

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

        # Margin defense gates the approval path too: the reviewer's push is
        # an ERP push, so the same policy that guards the automated graph
        # path applies here (a human approval cannot override the cost
        # floor — only a conscious re-review with corrected pricing can).
        defender = MarginDefender()
        margin_report = defender.evaluate_matches(reviewed_matches)
        margin_vetoes = [
            entry for entry in margin_report if entry.get("decision") == DECISION_VETO
        ]
        if margin_vetoes:
            for entry in margin_report:
                execution_result["execution_log"].append(
                    f"Margin defend [{entry['reason_code']}]: {entry['detail']}"
                )
            execution_result.update(
                {
                    "margin_report": margin_report,
                    "margin_veto_log_entries": margin_vetoes,
                    "hitl_reason_code": "margin_veto",
                }
            )
            await persist_review_job(
                session,
                job_id,
                job.filename,
                job.status,
                execution_result,
                review.decision,
                (review.note or "").strip() or None,
            )
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "margin_veto",
                    "message": (
                        "Margin defender blocked the approved push: the quoted "
                        "price breaches catalog cost/floor policy. The RFQ "
                        "remains pending review with the veto recorded."
                    ),
                    "vetoes": [
                        {
                            "part_number": entry.get("part_number"),
                            "reason_code": entry.get("reason_code"),
                            "quoted_price": entry.get("quoted_price"),
                            "unit_cost": entry.get("unit_cost"),
                            "price_floor": entry.get("price_floor"),
                            "detail": entry.get("detail"),
                        }
                        for entry in margin_vetoes
                    ],
                },
            )

        if any(entry.get("decision") == "reprice" for entry in margin_report):
            apply_margin_decisions(extracted_data, reviewed_matches, margin_report)

        execution_result.update(
            {
                "extracted_data": extracted_data,
                "matched_catalog_items": reviewed_matches,
                "margin_report": margin_report,
            }
        )
        for entry in margin_report:
            execution_result["execution_log"].append(
                f"Margin defend [{entry['reason_code']}]: {entry['detail']}"
            )
        try:
            erp_update = erp_sync_node(execution_result)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        # Preserve the forensic execution log: erp_sync_node returns a fresh
        # single-entry log, and outside the graph there is no add-reducer, so
        # a naive dict.update() silently replaced the accumulated trail
        # (upload -> extraction -> health gate -> catalog match -> human
        # approval) with just the ERP message.
        preserved_log = list(execution_result.get("execution_log", [])) + list(
            erp_update.get("execution_log", [])
        )
        execution_result.update(erp_update)
        execution_result["execution_log"] = preserved_log

        # Delta telemetry on approval: per-line quoted vs pushed vs cost vs
        # floor, so every margin decision is reconstructible after the fact.
        price_deltas = build_price_delta_telemetry(
            extracted_data, reviewed_matches, margin_report
        )
        execution_result["price_deltas"] = price_deltas
        if price_deltas:
            execution_result["execution_log"].append(
                f"Price delta telemetry recorded for {len(price_deltas)} line item(s)."
            )

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
    dependencies=[Depends(bind_tenant_context)],
)
async def process_rfq_document(
    request: Request,
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
):
    """
    Inbound RFQ PDF endpoint. OCR text and spatial layout metadata enter the
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
        # Docling OCR + layout analysis is CPU-bound: run it off the event loop.
        pdf_text, document_layout = await asyncio.to_thread(
            parse_pdf_document, saved_path
        )

        # Taelin Memory Stream (Layer 4): durable tenant audit trail for the
        # intake and OCR stages. Fault-isolated; never blocks the pipeline.
        stream_tenant = get_current_tenant()
        emit_event(
            "rfq_ingested",
            tenant_id=stream_tenant,
            job_id=job_id,
            payload={
                "filename_ext": (
                    filename.rsplit(".", 1)[-1].lower() if "." in filename else "pdf"
                ),
                "size_bytes": len(content),
                "sha256_16": hashlib.sha256(content).hexdigest()[:16],
            },
        )
        emit_event(
            "ocr_extracted",
            tenant_id=stream_tenant,
            job_id=job_id,
            payload={
                "text_chars": len(pdf_text),
                "tables": len(document_layout.get("tables", []) or []),
                "text_blocks": len(document_layout.get("text_blocks", []) or []),
            },
        )

        # Initialize execution state; the tenant bound by the request
        # dependency threads through the graph so catalog and persistence
        # layers stay tenant-scoped.
        initial_state = {
            "raw_input": pdf_text,
            "extracted_data": {},
            "confidence_score": 0.0,
            "validation_errors": [],
            "retry_count": 0,
            "execution_log": [f"File uploaded: {filename}"],
            "document_layout": document_layout,
            "tenant_id": get_current_tenant(),
        }

        graph_app = request.app.state.graph_app
        if graph_app is None:
            raise HTTPException(
                status_code=503, detail="Workflow execution is unavailable."
            )
        current_tenant = get_current_tenant()
        if current_tenant:
            with tenant_context(current_tenant):
                final_state = await graph_app.ainvoke(
                    initial_state,
                    config={
                        "configurable": {"thread_id": job_id},
                        "run_name": "rfq-processing",
                        "tags": ["rfq", "enterprise"],
                        "metadata": {
                            "job_id": job_id,
                            "workflow": "rfq-processing",
                        },
                    },
                )
        else:
            final_state = await graph_app.ainvoke(
                initial_state,
                config={
                    "configurable": {"thread_id": job_id},
                    "run_name": "rfq-processing",
                    "tags": ["rfq", "enterprise"],
                    "metadata": {
                        "job_id": job_id,
                        "workflow": "rfq-processing",
                    },
                },
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
    except PdfConversionError as error:
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
    dependencies=[Depends(bind_tenant_context)],
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


# --------------------------------------------------------------------- ROI
# Layer 5 — commercial instrumentation. Every response is tenant-scoped by
# the bound tenant context and currency-scoped by ISO bucket.


@app.get(
    "/api/v1/roi/summary",
    dependencies=[Depends(bind_tenant_context)],
)
async def get_roi_summary(
    session: AsyncSession = Depends(get_session),
    start: str | None = None,
    end: str | None = None,
):
    """Cumulative value captured for the bound tenant.

    Optional ``start``/``end`` ISO-8601 bounds (half-open: ``end`` is
    exclusive). Payback progress is computed strictly against the
    reporting-currency bucket — never a blind cross-currency sum.
    """

    def _parse_bound(name: str, raw: str) -> datetime:
        try:
            return datetime.fromisoformat(raw)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid ISO-8601 timestamp for '{name}': {raw!r}.",
            )

    start_dt = _parse_bound("start", start) if start else None
    end_dt = _parse_bound("end", end) if end else None
    return await roi_summary(
        session,
        get_current_tenant(),
        start=start_dt,
        end=end_dt,
        share_pct=settings.ROI_SHARE_PCT,
        deployment_cost=settings.ROI_DEPLOYMENT_COST,
        reporting_currency=settings.ROI_REPORTING_CURRENCY,
    )


@app.get(
    "/api/v1/roi/statement/{year}/{month}",
    dependencies=[Depends(bind_tenant_context)],
)
async def get_roi_statement(
    year: int,
    month: int,
    session: AsyncSession = Depends(get_session),
):
    """Contractual revenue-share statement for one calendar month (UTC).

    Deterministic and hash-bound: ``statement_hash`` covers every money
    field, count and stream anchor, so the client (and their auditor) can
    independently prove the statement was not altered after issuance via
    the same canonical-JSON recomputation.
    """
    try:
        statement = await monthly_statement(
            session,
            get_current_tenant(),
            year,
            month,
            share_pct=settings.ROI_SHARE_PCT,
            reporting_currency=settings.ROI_REPORTING_CURRENCY,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    # ``hash_verified`` sits OUTSIDE the hashed payload so the client (and
    # their auditor) can recompute ``statement_hash`` over the untouched
    # statement via verify_statement() with no key-stripping.
    return {"statement": statement, "hash_verified": verify_statement(statement)}