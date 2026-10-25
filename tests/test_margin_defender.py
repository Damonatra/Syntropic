"""Layer 3 Vector 4 — Margin Defender enforcement tests.

Covers the defender policy at unit level, the graph integration (a hard
breach is vetoed to HITL, a soft breach is repriced to floor with delta
telemetry, a healthy quote pushes unchanged), the approval path (the
forensic execution log survives, delta telemetry is recorded, and a human
approval cannot override a cost-floor veto), and the ERP webhook surface.
"""

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

import syntropic.core.matching.api.main as api
from syntropic.core.engine import build_syntropic_engine
from syntropic.core.matching.api.auth import require_authenticated_user
from syntropic.core.matching.api.database import approved_webhook_payload
from syntropic.core.matching.api.main import _status_from_final_state
from syntropic.core.matching.margin_defender import (
    DECISION_PASS,
    DECISION_REPRICE,
    DECISION_VETO,
    MarginDefender,
    REASON_BELOW_FLOOR,
    REASON_MARGIN_OK,
    REASON_NEGATIVE_MARGIN,
    REASON_NO_CATALOG_MATCH,
    REASON_NO_COST_BASIS,
    REASON_NO_QUOTED_PRICE,
    REASON_REPRICED_TO_FLOOR,
    apply_margin_decisions,
    build_price_delta_telemetry,
)

CATALOG_VALVE = {
    "sku_id": "CAT-001",
    "part_number": "VALVE-SS-050",
    "unit_price": 42.00,
    "unit_cost": 28.00,
    "price_floor": 33.60,
    "category": "Valves",
    "currency": "USD",
}


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


# ---------------------------------------------------------------------
# Unit — MarginDefender policy
# ---------------------------------------------------------------------

def test_negative_margin_is_vetoed_with_full_price_record():
    decision = MarginDefender().evaluate_line_item(
        {"unit_price": 4.20, "quantity": 500}, CATALOG_VALVE
    )

    assert decision["decision"] == DECISION_VETO
    assert decision["reason_code"] == REASON_NEGATIVE_MARGIN
    assert decision["quoted_price"] == 4.20
    assert decision["unit_cost"] == 28.00
    assert decision["price_floor"] == 33.60
    assert "below unit cost" in decision["detail"]


def test_soft_breach_is_repriced_to_floor_with_delta_fields():
    decision = MarginDefender().evaluate_line_item(
        {"unit_price": 30.00}, CATALOG_VALVE
    )

    assert decision["decision"] == DECISION_REPRICE
    assert decision["reason_code"] == REASON_REPRICED_TO_FLOOR
    assert decision["repriced"] is True
    assert decision["quoted_price"] == 30.00
    assert decision["effective_price"] == 33.60
    assert decision["effective_margin_pct"] == round((33.60 - 28.0) / 33.60, 4)


def test_soft_breach_is_vetoed_when_repricing_disabled():
    decision = MarginDefender(reprice_enabled=False).evaluate_line_item(
        {"unit_price": 30.00}, CATALOG_VALVE
    )

    assert decision["decision"] == DECISION_VETO
    assert decision["reason_code"] == REASON_BELOW_FLOOR


def test_healthy_margin_passes_unchanged():
    decision = MarginDefender().evaluate_line_item(
        {"unit_price": 45.00}, CATALOG_VALVE
    )

    assert decision["decision"] == DECISION_PASS
    assert decision["reason_code"] == REASON_MARGIN_OK
    assert decision["effective_price"] == 45.00
    assert decision["repriced"] is False


def test_missing_cost_basis_vetoes_fail_closed():
    decision = MarginDefender().evaluate_line_item(
        {"unit_price": 45.00},
        {"sku_id": "CAT-404", "part_number": "MYSTERY-1"},
    )

    assert decision["decision"] == DECISION_VETO
    assert decision["reason_code"] == REASON_NO_COST_BASIS


def test_zero_cost_basis_vetoes_fail_closed():
    decision = MarginDefender().evaluate_line_item(
        {"unit_price": 45.00},
        {"sku_id": "CAT-405", "part_number": "ZERO-COST", "unit_cost": 0},
    )

    assert decision["decision"] == DECISION_VETO
    assert decision["reason_code"] == REASON_NO_COST_BASIS


def test_missing_quoted_price_passes_for_erp_side_pricing():
    decision = MarginDefender().evaluate_line_item(
        {"quantity": 3, "part_number": "VALVE-SS-050"}, CATALOG_VALVE
    )

    assert decision["decision"] == DECISION_PASS
    assert decision["reason_code"] == REASON_NO_QUOTED_PRICE


def test_unmatched_line_passes_with_no_catalog_match_reason():
    decision = MarginDefender().evaluate_line_item({"unit_price": 1.0}, None)

    assert decision["decision"] == DECISION_PASS
    assert decision["reason_code"] == REASON_NO_CATALOG_MATCH


def test_explicit_floor_wins_over_derived_floor():
    defender = MarginDefender(margin_floor_pct=0.5)

    assert defender.floor_price_for({"unit_cost": 100.0}) == 200.0
    assert defender.floor_price_for(
        {"unit_cost": 100.0, "price_floor": 120.0}
    ) == 120.0


def test_apply_margin_decisions_updates_line_items_and_match_records():
    extracted = {
        "part_number": "VALVE-SS-050",
        "unit_price": 30.00,
        "line_items": [{"part_number": "VALVE-SS-050", "unit_price": 30.00}],
    }
    matches = [
        {
            "extracted_item": {"part_number": "VALVE-SS-050", "unit_price": 30.00},
            "catalog_item": dict(CATALOG_VALVE),
        }
    ]
    report = MarginDefender().evaluate_matches(matches)

    apply_margin_decisions(extracted, matches, report)

    assert extracted["line_items"][0]["unit_price"] == 33.60
    assert extracted["unit_price"] == 33.60  # single-item mirror updated too
    assert matches[0]["extracted_item"]["unit_price"] == 33.60


def test_price_delta_telemetry_links_quoted_pushed_cost_floor():
    extracted = {
        "part_number": "VALVE-SS-050",
        "unit_price": 30.00,
        "line_items": [{"part_number": "VALVE-SS-050", "quantity": 500, "unit_price": 30.00}],
    }
    matches = [
        {
            "extracted_item": {"part_number": "VALVE-SS-050", "unit_price": 30.00},
            "catalog_item": dict(CATALOG_VALVE),
        }
    ]
    report = MarginDefender().evaluate_matches(matches)
    apply_margin_decisions(extracted, matches, report)

    deltas = build_price_delta_telemetry(extracted, matches, report)

    assert deltas[0]["quoted_price"] == 30.00
    assert deltas[0]["pushed_price"] == 33.60
    assert deltas[0]["unit_cost"] == 28.00
    assert deltas[0]["price_floor"] == 33.60
    assert deltas[0]["repriced"] is True
    assert deltas[0]["reason_code"] == REASON_REPRICED_TO_FLOOR
    assert deltas[0]["margin_pct_at_push"] == round((33.60 - 28.0) / 33.60, 4)


# ---------------------------------------------------------------------
# Graph integration — the margin_defend node gates ERP pushes
# ---------------------------------------------------------------------

def _invoke_graph(raw_input: str) -> dict:
    return build_syntropic_engine().invoke(
        {
            "raw_input": raw_input,
            "extracted_data": {},
            "confidence_score": 0.0,
            "validation_errors": [],
            "retry_count": 0,
            "execution_log": [],
        }
    )


def test_below_cost_quote_is_vetoed_and_routed_to_pending_hitl():
    result = _invoke_graph(
        "Part Number: VALVE-SS-050\nQuantity: 500 EA\nUnit Price: $4.20"
    )

    assert result.get("webhook_dispatch_requested", False) is False
    assert result["hitl_reason_code"] == "margin_veto"
    assert result["margin_veto_log_entries"], "structured veto entries missing"
    veto = result["margin_veto_log_entries"][0]
    assert veto["reason_code"] == REASON_NEGATIVE_MARGIN
    assert veto["part_number"] == "VALVE-SS-050"
    assert result["margin_report"][0]["decision"] == DECISION_VETO
    assert any(
        entry.startswith("Margin defend [MARGIN_NEGATIVE]:")
        for entry in result["execution_log"]
    )
    assert any(
        entry.startswith("Pending HITL review: margin defender blocked")
        for entry in result["execution_log"]
    )
    assert _status_from_final_state(result) == "pending_hitl"


def test_soft_breach_quote_is_repriced_to_floor_and_pushed():
    result = _invoke_graph(
        "Part Number: VALVE-SS-050\nQuantity: 500 EA\nUnit Price: $30.00"
    )

    assert result["webhook_dispatch_requested"] is True
    line_item = result["extracted_data"]["line_items"][0]
    assert line_item["unit_price"] == 33.60
    assert result["margin_report"][0]["reason_code"] == REASON_REPRICED_TO_FLOOR
    deltas = result["price_deltas"]
    assert deltas[0]["quoted_price"] == 30.00
    assert deltas[0]["pushed_price"] == 33.60
    assert deltas[0]["repriced"] is True


def test_healthy_quote_pushes_without_repricing():
    result = _invoke_graph(
        "Part Number: VALVE-SS-050\nQuantity: 500 EA\nUnit Price: $45.00"
    )

    assert result["webhook_dispatch_requested"] is True
    assert result["extracted_data"]["line_items"][0]["unit_price"] == 45.00
    assert all(
        entry["decision"] != DECISION_VETO for entry in result["margin_report"]
    )


# ---------------------------------------------------------------------
# Approval path — forensic log, delta telemetry, veto cannot be overridden
# ---------------------------------------------------------------------

FORENSIC_LOG = [
    "File uploaded: quote.pdf",
    "Extraction completed with graded confidence: 1.00",
    "Normalization applied UoM + trade attributes.",
    "Health gate decision: review (confidence 1.00/0.85, payload valid, retry 0/2).",
    "Catalog match for line item 1: VALVE-SS-050 with score 1.0000.",
    "Flagged for Human Review: Catalog match score 0.31 below threshold.",
    "Human reviewer approved 1 RFQ line item(s).",
]


def _seed_job_with_price(review_client, unit_price):
    execution_result = {
        "confidence_score": 1.0,
        "extracted_data": {
            "part_number": "VALVE-SS-050",
            "quantity": 500,
            "unit_of_measure": "EA",
            "unit_price": unit_price,
            "line_items": [
                {
                    "part_number": "VALVE-SS-050",
                    "quantity": 500,
                    "unit_of_measure": "EA",
                    "unit_price": unit_price,
                }
            ],
        },
        "matched_catalog_item": dict(CATALOG_VALVE),
        "matched_catalog_items": [
            {"catalog_item": dict(CATALOG_VALVE), "rrf_score": 1.0}
        ],
        "catalog_match_score": 1.0,
        "validation_errors": [],
        "execution_log": FORENSIC_LOG[:-1],
    }
    with sqlite3.connect(api.app.state.test_db_path) as connection:
        connection.execute(
            """INSERT INTO rfq_jobs
               (job_id, tenant_id, filename, status, execution_result)
               VALUES (?, ?, ?, ?, ?)""",
            (
                "job-margin",
                "test-reviewer",
                "quote.pdf",
                "flagged_for_review",
                json.dumps(execution_result),
            ),
        )


def _read_job(job_id):
    with sqlite3.connect(api.app.state.test_db_path) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            "SELECT * FROM rfq_jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
    result = dict(row)
    result["execution_result"] = json.loads(result["execution_result"])
    return result


def _read_outbox(job_id):
    with sqlite3.connect(api.app.state.test_db_path) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            "SELECT * FROM webhook_outbox WHERE job_id = ?", (job_id,)
        ).fetchone()
    return dict(row) if row else None


def test_approval_preserves_forensic_log_and_records_delta_telemetry(
    review_client,
):
    _seed_job_with_price(review_client, 45.00)

    response = review_client.post(
        "/api/v1/rfq/job-margin/review", json={"decision": "approve"}
    )

    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    result = response.json()["execution_result"]
    log = result["execution_log"]
    # Every forensic entry survives — including the human approval itself.
    for entry in FORENSIC_LOG:
        assert entry in log
    assert any(
        entry.startswith("ERP webhook queued for catalog items")
        for entry in log
    )
    assert any(
        entry.startswith("Price delta telemetry recorded for 1 line item(s).")
        for entry in log
    )
    deltas = result["price_deltas"]
    assert deltas[0]["quoted_price"] == 45.00
    assert deltas[0]["pushed_price"] == 45.00
    assert deltas[0]["repriced"] is False
    assert deltas[0]["unit_cost"] == 28.00
    # The persisted job carries the same trail.
    persisted = _read_job("job-margin")["execution_result"]
    assert len(persisted["execution_log"]) == len(log)
    # And the ERP webhook payload exposes the margin telemetry.
    payload = json.loads(_read_outbox("job-margin")["payload"])
    assert payload["margin_report"]
    assert payload["price_deltas"][0]["pushed_price"] == 45.00


def test_human_approval_cannot_override_a_cost_floor_veto(review_client):
    _seed_job_with_price(review_client, 4.20)

    response = review_client.post(
        "/api/v1/rfq/job-margin/review", json={"decision": "approve"}
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "margin_veto"
    assert detail["vetoes"][0]["reason_code"] == REASON_NEGATIVE_MARGIN
    assert detail["vetoes"][0]["quoted_price"] == 4.20
    # The job stays in the reviewable queue with the veto recorded.
    job = _read_job("job-margin")
    assert job["status"] == "flagged_for_review"
    assert job["execution_result"]["hitl_reason_code"] == "margin_veto"
    assert job["execution_result"]["margin_veto_log_entries"]
    assert any(
        entry.startswith("Margin defend [MARGIN_NEGATIVE]:")
        for entry in job["execution_result"]["execution_log"]
    )
    # No ERP event may exist for a vetoed push.
    assert _read_outbox("job-margin") is None


def test_approval_reprices_soft_breach_before_erp_push(review_client):
    _seed_job_with_price(review_client, 30.00)

    response = review_client.post(
        "/api/v1/rfq/job-margin/review", json={"decision": "approve"}
    )

    assert response.status_code == 200
    result = response.json()["execution_result"]
    assert result["extracted_data"]["line_items"][0]["unit_price"] == 33.60
    assert result["margin_report"][0]["reason_code"] == REASON_REPRICED_TO_FLOOR
    assert result["price_deltas"][0]["repriced"] is True
    assert result["price_deltas"][0]["pushed_price"] == 33.60
    payload = json.loads(_read_outbox("job-margin")["payload"])
    assert payload["line_items"][0]["unit_price"] == 33.60


# ---------------------------------------------------------------------
# ERP payload surface
# ---------------------------------------------------------------------

def test_approved_webhook_payload_carries_margin_telemetry():
    execution_result = {
        "confidence_score": 1.0,
        "extracted_data": {
            "part_number": "VALVE-SS-050",
            "quantity": 500,
            "unit_of_measure": "EA",
            "unit_price": 33.60,
        },
        "matched_catalog_items": [
            {"catalog_item": dict(CATALOG_VALVE), "rrf_score": 1.0}
        ],
        "margin_report": [
            {
                "decision": DECISION_REPRICE,
                "reason_code": REASON_REPRICED_TO_FLOOR,
                "part_number": "VALVE-SS-050",
            }
        ],
        "price_deltas": [
            {
                "part_number": "VALVE-SS-050",
                "quoted_price": 30.0,
                "pushed_price": 33.6,
                "repriced": True,
            }
        ],
    }

    payload = approved_webhook_payload("job-1", "quote.pdf", execution_result)

    assert payload["event"] == "rfq.approved"
    assert payload["margin_report"][0]["reason_code"] == REASON_REPRICED_TO_FLOOR
    assert payload["price_deltas"][0]["pushed_price"] == 33.6
