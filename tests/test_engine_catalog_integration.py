from syntropic.core.engine import (
    build_syntropic_engine,
    health_gate_node,
    human_in_the_loop_node,
)
from syntropic.core.matching.api.main import _status_from_final_state, app


def test_workflow_matches_catalog_before_erp_push():
    app = build_syntropic_engine()

    initial_state = {
        "raw_input": "PN: VALVE-1/2-SS\nQty: 500",
        "extracted_data": {},
        "confidence_score": 0.0,
        "validation_errors": [],
        "retry_count": 0,
        "execution_log": [],
    }

    result = app.invoke(initial_state)

    assert result["matched_catalog_item"]["part_number"] == "VALVE-SS-050"
    assert result["catalog_match_score"] >= 0.5
    assert result["webhook_dispatch_requested"] is True
    assert result["health_gate_decision"] == "approve"
    assert result["health_gate_payload_valid"] is True
    assert any(
        "Health gate decision: heal" in entry for entry in result["execution_log"]
    )
    assert any(
        "Health gate decision: approve" in entry
        for entry in result["execution_log"]
    )
    assert any(
        entry.startswith("ERP webhook queued")
        for entry in result["execution_log"]
    )
    assert result["execution_log"]


def test_api_import_does_not_initialize_engine_and_status_tracks_outcome():
    assert getattr(app.state, "graph_app", None) is None

    review_state = {
        "confidence_score": 1.0,
        "execution_log": ["Flagged for Human Review: No catalog match found."],
    }
    completed_state = {
        "confidence_score": 1.0,
        "execution_log": ["Payload matched catalog item VALVE-SS-050 before ERP commit."],
    }

    assert _status_from_final_state(review_state) == "flagged_for_review"
    assert _status_from_final_state(completed_state) == "completed"
    assert getattr(app.state, "graph_app", None) is None


def test_catalog_review_log_reports_match_score_reason():
    result = human_in_the_loop_node(
        {
            "confidence_score": 1.0,
            "validation_errors": [],
            "catalog_match_score": 0.31,
            "execution_log": [],
        }
    )

    assert "Catalog match score 0.31 below threshold" in result["execution_log"][0]


def test_health_gate_records_decision_and_inputs_for_tracing():
    gate = health_gate_node(
        {
            "raw_input": "Part number: VALVE-SS-050\nQuantity: 2",
            "extracted_data": {"part_number": "VALVE-SS-050", "quantity": 2},
            "confidence_score": 1.0,
            "validation_errors": [],
            "retry_count": 0,
            "execution_log": [],
        }
    )

    assert gate["health_gate_decision"] == "approve"
    assert gate["health_gate_score"] == 1.0
    assert gate["health_gate_threshold"] == 0.85
    assert gate["health_gate_payload_valid"] is True
    assert gate["execution_log"] == [
        "Health gate decision: approve "
        "(confidence 1.00/0.85, payload valid, retry 0/2)."
    ]


def test_health_gate_records_review_after_retries_are_exhausted():
    gate = health_gate_node(
        {
            "raw_input": "unstructured request",
            "extracted_data": {},
            "confidence_score": 0.0,
            "validation_errors": ["part_number: required"],
            "retry_count": 2,
            "execution_log": [],
        }
    )

    assert gate["health_gate_decision"] == "review"
    assert gate["health_gate_payload_valid"] is False
