"""Market-readiness remediation tests.

Covers the V1 and V2 remediation surface: per-line-item graded confidence,
the HITL 0.95 automation floor with structured pending_hitl status,
multi-currency extraction, document-layout provenance wiring, SPA rebate
interception, and review-queue integration for pending_hitl jobs.
"""

import json
import sqlite3
from datetime import date

import pytest
from fastapi.testclient import TestClient

import syntropic.core.matching.api.main as api
from syntropic.core.engine import (
    CONFIDENCE_PENALTIES,
    HITL_CONFIDENCE_FLOOR,
    _extract_payload,
    build_syntropic_engine,
    spa_rebate_node,
)
from syntropic.core.matching.api.main import _status_from_final_state
from syntropic.core.matching.rebates import SPARebateInterceptor
from syntropic.evaluation import predicted_workflow_status


# ---------------------------------------------------------------------
# Graded confidence
# ---------------------------------------------------------------------

def test_clean_extraction_reaches_full_confidence_with_uom_and_currency():
    extracted, confidence, errors = _extract_payload(
        "Part Number: VALVE-SS-050\nQuantity: 10 EA\nUnit Price: USD 42.00"
    )

    assert errors == []
    assert confidence == 1.0
    line_item = extracted["line_items"][0]
    assert line_item["extraction_confidence"] == 1.0
    assert line_item["unit_price"] == 42.0
    assert line_item["currency"] == "USD"


def test_missing_uom_routes_below_floor_to_pending_hitl():
    result = build_syntropic_engine().invoke(
        {
            "raw_input": "Part Number: VALVE-SS-050\nQuantity: 10",
            "extracted_data": {},
            "confidence_score": 0.0,
            "validation_errors": [],
            "retry_count": 0,
            "execution_log": [],
        }
    )

    assert result["confidence_score"] == 0.94
    assert result["hitl_reason_code"] == "below_confidence_floor"
    assert "webhook_dispatch_requested" not in result
    assert any(
        message.startswith("Pending HITL review:")
        for message in result["execution_log"]
    )
    assert _status_from_final_state(result) == "pending_hitl"


def test_abbreviated_labels_incur_confidence_penalty():
    extracted, confidence, errors = _extract_payload(
        "PN: VALVE-BR-050\nQty: 50 EA",
        allow_abbreviations=True,
    )

    assert errors == []
    assert confidence == round(
        1.0 - CONFIDENCE_PENALTIES["abbreviated_label"], 4
    )
    assert extracted["line_items"][0]["extraction_confidence"] == confidence


def test_validation_errors_penalize_line_item_confidence():
    extracted, confidence, errors = _extract_payload(
        "Part Number: VALVE-SS-050\nQuantity: 2 EA\nUnit Price: $0"
    )

    # A single validation error (unit price must be > 0) costs 0.25 on top
    # of an otherwise clean line item whose unit of measure is present.
    assert len(errors) == 1
    assert errors[0].startswith("line_items.0.unit_price:")
    expected = round(
        1.0 - CONFIDENCE_PENALTIES["validation_error"] * 1, 4
    )
    assert confidence == expected
    assert extracted["line_items"][0]["extraction_confidence"] == expected


def test_spatial_anchor_wiring_attaches_document_provenance():
    provenance = [
        {
            "page_no": 2,
            "bbox": {
                "left": 51.2,
                "top": 88.5,
                "right": 210.7,
                "bottom": 102.3,
                "coord_origin": "BOTTOMLEFT",
            },
        }
    ]
    document_layout = {
        "file_name": "quote.pdf",
        "text_blocks": [
            {
                "label": "text",
                "text": "Part Number: VALVE-SS-050 Quantity: 10 EA",
                "provenance": provenance,
            }
        ],
        "tables": [],
    }

    extracted, confidence, errors = _extract_payload(
        "Part Number: VALVE-SS-050\nQuantity: 10 EA",
        document_layout=document_layout,
    )

    assert errors == []
    assert confidence == 1.0
    assert extracted["line_items"][0]["provenance"] == provenance


def test_unanchored_line_item_penalized_when_layout_present():
    document_layout = {
        "file_name": "quote.pdf",
        "text_blocks": [
            {
                "label": "text",
                "text": "Unrelated cover page text",
                "provenance": [{"page_no": 1, "bbox": {
                    "left": 0.0, "top": 0.0, "right": 10.0, "bottom": 10.0,
                    "coord_origin": "BOTTOMLEFT",
                }}],
            }
        ],
        "tables": [],
    }

    _, confidence, errors = _extract_payload(
        "Part Number: VALVE-SS-050\nQuantity: 10 EA",
        document_layout=document_layout,
    )

    assert errors == []
    assert confidence == round(
        1.0 - CONFIDENCE_PENALTIES["no_spatial_anchor"], 4
    )


def test_global_confidence_is_minimum_across_line_items():
    extracted, confidence, errors = _extract_payload(
        "Part Number: VALVE-SS-050\nQuantity: 10 EA\n"
        "Part Number: PIPE-SS-100\nQuantity: 3"
    )

    assert errors == []
    item_scores = [
        item["extraction_confidence"] for item in extracted["line_items"]
    ]
    assert item_scores == [1.0, 0.94]
    assert confidence == 0.94


def test_currency_extraction_supports_labeled_symbol_and_suffix_forms():
    cases = [
        ("Unit Price: USD 42.00", "USD", 42.00),
        ("Unit Price: $42.00", "USD", 42.00),
        ("Unit Price: 18.50 EUR", "EUR", 18.50),
        ("Unit Price: €12.50", "EUR", 12.50),
        ("Unit Price: £86.00", "GBP", 86.00),
        ("Unit Price: ¥980.00", "JPY", 980.00),
        ("Unit Cost: 42.00", None, 42.00),
    ]
    for price_text, expected_currency, expected_amount in cases:
        extracted, _, errors = _extract_payload(
            f"Part Number: VALVE-SS-050\nQuantity: 2 EA\n{price_text}"
        )
        assert errors == []
        line_item = extracted["line_items"][0]
        assert line_item["unit_price"] == expected_amount, price_text
        assert line_item.get("currency") == expected_currency, price_text


def test_full_confidence_input_completes_and_queues_erp_webhook():
    result = build_syntropic_engine().invoke(
        {
            "raw_input": (
                "Part Number: VALVE-SS-050\nQuantity: 10 EA\n"
                "Unit Price: USD 42.00"
            ),
            "extracted_data": {},
            "confidence_score": 0.0,
            "validation_errors": [],
            "retry_count": 0,
            "execution_log": [],
        }
    )

    assert result["confidence_score"] == 1.0
    assert result["webhook_dispatch_requested"] is True
    assert result["matched_catalog_item"]["part_number"] == "VALVE-SS-050"
    assert _status_from_final_state(result) == "completed"
    reason_codes = {flag["reason_code"] for flag in result["rebate_flags"]}
    assert "UNAPPLIED_REBATE" in reason_codes


# ---------------------------------------------------------------------
# SPA rebate interception
# ---------------------------------------------------------------------

def _schedule_item(**overrides):
    item = {
        "sku_id": "CAT-001",
        "part_number": "VALVE-SS-050",
        "unit_price": 42.00,
        "rebate_schedule": {
            "rebate_pct": 0.05,
            "effective_from": "2026-01-01",
            "effective_until": "2026-12-31",
            "volume_tiers": [{"min_qty": 100, "rebate_pct": 0.08}],
        },
        "cost_sheet_updated": "2026-09-20",
    }
    item.update(overrides)
    return item


def test_spa_interceptor_flags_unapplied_rebate():
    interceptor = SPARebateInterceptor(today=date(2026, 6, 1))
    flags = interceptor.intercept_line_item(
        {"quantity": 10, "unit_price": 42.00},
        _schedule_item(),
    )

    codes = [flag["reason_code"] for flag in flags]
    assert "UNAPPLIED_REBATE" in codes
    unapplied = next(flag for flag in flags if flag["reason_code"] == "UNAPPLIED_REBATE")
    assert "39.90" in unapplied["detail"]


def test_spa_interceptor_flags_volume_tier_opportunity():
    interceptor = SPARebateInterceptor(today=date(2026, 6, 1))
    flags = interceptor.intercept_line_item(
        {"quantity": 250, "unit_price": 38.64},
        _schedule_item(),
    )

    codes = [flag["reason_code"] for flag in flags]
    assert "VOLUME_TIER_AVAILABLE" in codes
    tier_flag = next(
        flag for flag in flags if flag["reason_code"] == "VOLUME_TIER_AVAILABLE"
    )
    assert "8%" in tier_flag["detail"]


def test_spa_interceptor_flags_stale_cost_sheet():
    interceptor = SPARebateInterceptor(today=date(2026, 10, 26))
    flags = interceptor.intercept_line_item(
        {"quantity": 10, "unit_price": 39.90},
        _schedule_item(cost_sheet_updated="2026-01-15"),
    )

    codes = [flag["reason_code"] for flag in flags]
    assert "COST_SHEET_LAG" in codes
    assert all(flag["reason_code"] != "UNAPPLIED_REBATE" for flag in flags)


def test_spa_interceptor_flags_malformed_schedule():
    interceptor = SPARebateInterceptor(today=date(2026, 6, 1))
    flags = interceptor.intercept_line_item(
        {"quantity": 10, "unit_price": 42.00},
        _schedule_item(
            rebate_schedule={
                "effective_from": "2026-12-31",
                "effective_until": "2026-01-01",
            }
        ),
    )

    assert [flag["reason_code"] for flag in flags] == ["MALFORMED_SCHEDULE"]


def test_spa_rebate_node_records_flags_and_logs():
    result = spa_rebate_node(
        {
            "matched_catalog_items": [
                {
                    "extracted_item": {"part_number": "VALVE-SS-050", "quantity": 10},
                    "catalog_item": _schedule_item(
                        cost_sheet_updated="2026-01-15",
                        rebate_schedule={
                            "rebate_pct": 0.05,
                            "effective_from": "2026-01-01",
                            "effective_until": "2026-12-31",
                            "volume_tiers": [
                                {"min_qty": 500, "rebate_pct": 0.12}
                            ],
                        },
                    ),
                    "rrf_score": 0.9,
                }
            ]
        }
    )

    reason_codes = {flag["reason_code"] for flag in result["rebate_flags"]}
    assert reason_codes == {"UNAPPLIED_REBATE", "COST_SHEET_LAG"}
    assert result["rebate_flags"][0]["line_part_number"] == "VALVE-SS-050"
    assert any(
        message.startswith("SPA rebate intercept [UNAPPLIED_REBATE]:")
        for message in result["execution_log"]
    )


# ---------------------------------------------------------------------
# Review queue integration for pending_hitl
# ---------------------------------------------------------------------

@pytest.fixture
def review_client(tmp_path, monkeypatch):
    database_path = (tmp_path / "review_queue.sqlite3").as_posix()
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{database_path}")
    api.app.state.test_db_path = tmp_path / "review_queue.sqlite3"
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path / "uploads")
    api.UPLOAD_DIR.mkdir()
    api.app.state.testing = True
    from syntropic.core.matching.api.auth import require_authenticated_user

    api.app.dependency_overrides[require_authenticated_user] = lambda: {
        "sub": "test-reviewer"
    }
    with TestClient(api.app) as client:
        yield client
    api.app.dependency_overrides.clear()
    api.app.state.testing = False


def test_review_queue_and_decision_guard_accept_pending_hitl(review_client):
    execution_result = {
        "confidence_score": 0.94,
        "hitl_reason_code": "below_confidence_floor",
        "extracted_data": {"part_number": "VALVE-SS-050", "quantity": 2},
        "validation_errors": [],
        "execution_log": [
            "Pending HITL review: extraction confidence 0.94 is below the "
            "0.95 automation floor."
        ],
    }
    with sqlite3.connect(api.app.state.test_db_path) as connection:
        connection.execute(
            """INSERT INTO rfq_jobs
               (job_id, tenant_id, filename, status, execution_result)
               VALUES (?, ?, ?, ?, ?)""",
            (
                "job-pending",
                "test-reviewer",
                "quote.pdf",
                "pending_hitl",
                json.dumps(execution_result),
            ),
        )

    queue_response = review_client.get("/api/v1/rfq/reviews")
    assert queue_response.json() == [
        {"job_id": "job-pending", "filename": "quote.pdf"}
    ]

    response = review_client.post(
        "/api/v1/rfq/job-pending/review",
        json={"decision": "approve", "note": "Confirmed rebate application."},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert review_client.get("/api/v1/rfq/reviews").json() == []


# ---------------------------------------------------------------------
# Structured status detection
# ---------------------------------------------------------------------

def test_evaluation_detects_pending_hitl_status_structurally():
    assert predicted_workflow_status(
        {
            "hitl_reason_code": "below_confidence_floor",
            "execution_log": ["Pending HITL review: below floor."],
        }
    ) == "pending_hitl"
    assert predicted_workflow_status(
        {
            "execution_log": ["Flagged for Human Review: bad match."],
        }
    ) == "flagged_for_review"
    assert predicted_workflow_status(
        {
            "webhook_dispatch_requested": True,
            "execution_log": ["ERP webhook queued."],
        }
    ) == "completed"
    assert HITL_CONFIDENCE_FLOOR == 0.95
