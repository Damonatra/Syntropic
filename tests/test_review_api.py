import pytest
from fastapi.testclient import TestClient

import syntropic.core.matching.api.main as api


@pytest.fixture
def review_client(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "REVIEW_DB_PATH", tmp_path / "review_queue.sqlite3")
    with TestClient(api.app) as client:
        yield client


def _add_pending_job(job_id="job-1"):
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
    api._save_review_job(
        job_id, "quote.pdf", "flagged_for_review", execution_result
    )


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
    assert api._get_review_job("job-1")["review_note"] == "Corrected against vendor quote."
    assert review_client.get("/api/v1/rfq/reviews").json() == []

    duplicate = review_client.post(
        "/api/v1/rfq/job-1/review", json={"decision": "reject"}
    )
    assert duplicate.status_code == 409


def test_reviewer_can_reject_a_job(review_client):
    _add_pending_job("job-2")

    response = review_client.post(
        "/api/v1/rfq/job-2/review",
        json={"decision": "reject", "note": "Duplicate request."},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "rejected"
    assert "Duplicate request." in response.json()["execution_result"]["execution_log"][-1]
    assert api._get_review_job("job-2")["review_decision"] == "reject"


def test_approval_requires_valid_part_number_and_quantity(review_client):
    _add_pending_job("job-3")

    response = review_client.post(
        "/api/v1/rfq/job-3/review",
        json={"decision": "approve", "part_number": " ", "quantity": 0},
    )

    assert response.status_code == 422
    assert api._get_review_job("job-3")["status"] == "flagged_for_review"