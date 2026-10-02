import asyncio
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

import syntropic.core.matching.api.main as api
from syntropic.core.matching.api.auth import require_authenticated_user


@pytest.fixture
def review_client(tmp_path, monkeypatch):
    database_path = (tmp_path / "review_queue.sqlite3").as_posix()
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{database_path}")
    api.app.state.test_db_path = tmp_path / "review_queue.sqlite3"
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path / "uploads")
    api.UPLOAD_DIR.mkdir()
    api.app.state.testing = True
    api.app.dependency_overrides[require_authenticated_user] = lambda: {
        "sub": "test-reviewer"
    }
    with TestClient(api.app) as client:
        yield client
    api.app.dependency_overrides.clear()
    api.app.state.testing = False


def _seed_pending_job(job_id="job-1", execution_result=None):
    if execution_result is None:
        execution_result = {
            "confidence_score": 1.0,
            "extracted_data": {"part_number": "VLV-SS-050", "quantity": 2},
            "matched_catalog_item": {"part_number": "VALVE-SS-050"},
            "catalog_match_score": 0.31,
            "validation_errors": [],
            "execution_log": [
                "Flagged for Human Review: Catalog match score 0.31 below threshold."
            ],
        }
    with sqlite3.connect(api.app.state.test_db_path) as connection:
        connection.execute(
            """INSERT INTO rfq_jobs
               (job_id, filename, status, execution_result)
               VALUES (?, ?, ?, ?)""",
            (
                job_id,
                "quote.pdf",
                "flagged_for_review",
                json.dumps(execution_result),
            ),
        )


def _add_pending_job(job_id="job-1"):
    _seed_pending_job(job_id)


def _read_job(job_id):
    with sqlite3.connect(api.app.state.test_db_path) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            "SELECT * FROM rfq_jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
    result = dict(row)
    result["execution_result"] = json.loads(result["execution_result"])
    return result


def test_review_routes_require_a_bearer_token(review_client):
    api.app.dependency_overrides.pop(require_authenticated_user)
    response = review_client.get("/api/v1/rfq/reviews")
    api.app.dependency_overrides[require_authenticated_user] = lambda: {
        "sub": "test-reviewer"
    }
    assert response.status_code == 401


def test_upload_sanitizes_client_filename_and_uses_checkpoint_thread_id(
    review_client, monkeypatch
):
    class Graph:
        async def ainvoke(self, state, config):
            assert config["configurable"]["thread_id"]
            return {**state, "execution_log": ["workflow completed"]}

    api.app.state.graph_app = Graph()
    monkeypatch.setattr(
        api,
        "parse_pdf_text",
        lambda path: "RFQ sample" if path.suffix.lower() == ".pdf" else "",
    )
    response = review_client.post(
        "/api/v1/rfq/process",
        files={"file": ("..\\outside.pdf", b"%PDF-1.4 test", "application/pdf")},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["filename"] == "outside.pdf"
    assert (api.UPLOAD_DIR / f"{result['job_id']}_outside.pdf").is_file()


def test_reviewer_can_correct_and_approve_a_persisted_job(review_client):
    _add_pending_job()

    queue_response = review_client.get("/api/v1/rfq/reviews")
    assert queue_response.json() == [{"job_id": "job-1", "filename": "quote.pdf"}]

    response = review_client.post(
        "/api/v1/rfq/job-1/review",
        json={
            "decision": "approve",
            "part_number": "VALVE-BR-050",
            "quantity": 4,
            "note": "Corrected against vendor quote.",
        },
    )

    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "completed"
    assert result["review_decision"] == "approve"
    assert result["execution_result"]["extracted_data"] == {
        "part_number": "VALVE-BR-050",
        "quantity": 4,
    }
    assert result["execution_result"]["matched_catalog_item"] is None
    assert _read_job("job-1")["review_note"] == "Corrected against vendor quote."
    assert review_client.get("/api/v1/rfq/reviews").json() == []

    duplicate = review_client.post(
        "/api/v1/rfq/job-1/review", json={"decision": "reject"}
    )
    assert duplicate.status_code == 409


def test_reviewer_can_correct_and_approve_multiple_line_items(review_client):
    execution_result = {
        "confidence_score": 1.0,
        "extracted_data": {
            "part_number": "VALVE-SS-050",
            "quantity": 2,
            "line_items": [
                {"part_number": "VALVE-SS-050", "quantity": 2},
                {"part_number": "PIPE-SS-100", "quantity": 3},
            ],
        },
        "matched_catalog_item": {"part_number": "VALVE-SS-050"},
        "matched_catalog_items": [
            {
                "catalog_item": {"part_number": "VALVE-SS-050"},
                "rrf_score": 1.0,
            },
            {"catalog_item": {"part_number": "PIPE-SS-100"}, "rrf_score": 1.0},
        ],
        "catalog_match_score": 1.0,
        "validation_errors": [],
        "execution_log": ["Flagged for Human Review: Manual verification required."],
    }
    _seed_pending_job("job-multi", execution_result)

    response = review_client.post(
        "/api/v1/rfq/job-multi/review",
        json={
            "decision": "approve",
            "line_items": [
                {"part_number": "VALVE-SS-050", "quantity": 4},
                {"part_number": "PIPE-SS-100", "quantity": 3},
            ],
        },
    )

    assert response.status_code == 200
    result = response.json()["execution_result"]
    assert result["extracted_data"]["line_items"] == [
        {"part_number": "VALVE-SS-050", "quantity": 4},
        {"part_number": "PIPE-SS-100", "quantity": 3},
    ]
    assert [
        match["catalog_item"]["part_number"]
        for match in result["matched_catalog_items"]
    ] == ["VALVE-SS-050", "PIPE-SS-100"]


def test_review_document_is_available_only_for_a_persisted_job(
    review_client,
):
    _add_pending_job("job-document")
    source_pdf = api.UPLOAD_DIR / "job-document_quote.pdf"
    source_pdf.write_bytes(b"%PDF-1.4 source")

    response = review_client.get(
        "/api/v1/rfq/reviews/job-document/document"
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content == b"%PDF-1.4 source"
    assert review_client.get(
        "/api/v1/rfq/reviews/unknown/document"
    ).status_code == 404


def test_reviewer_can_reject_a_job(review_client):
    _add_pending_job("job-2")

    response = review_client.post(
        "/api/v1/rfq/job-2/review",
        json={"decision": "reject", "note": "Duplicate request."},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "rejected"
    assert "Duplicate request." in response.json()["execution_result"]["execution_log"][-1]
    assert _read_job("job-2")["review_decision"] == "reject"


def test_review_queue_event_stream_emits_initial_and_updated_snapshots(
    review_client, monkeypatch
):
    class ConnectedRequest:
        async def is_disconnected(self):
            return False

    async def no_wait(seconds):
        assert seconds == 1
        return None

    monkeypatch.setattr(asyncio, "sleep", no_wait)

    async def read_events():
        events = api._review_queue_event_stream(
            ConnectedRequest(), api.app.state.session_factory
        )
        initial_event = await anext(events)
        _seed_pending_job("streamed-job")
        updated_event = await anext(events)
        await events.aclose()
        return initial_event, updated_event

    initial_event, updated_event = review_client.portal.call(read_events)

    assert initial_event["event"] == "review_queue"
    assert json.loads(initial_event["data"]) == {"reviews": []}
    assert updated_event["event"] == "review_queue"
    assert json.loads(updated_event["data"]) == {
        "reviews": [{"job_id": "streamed-job", "filename": "quote.pdf"}]
    }


def test_approval_requires_valid_part_number_and_quantity(review_client):
    _add_pending_job("job-3")

    response = review_client.post(
        "/api/v1/rfq/job-3/review",
        json={"decision": "approve", "part_number": " ", "quantity": 0},
    )

    assert response.status_code == 422
    assert _read_job("job-3")["status"] == "flagged_for_review"