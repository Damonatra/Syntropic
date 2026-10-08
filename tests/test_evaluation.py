import asyncio
import json

import pytest

import syntropic.evaluation as evaluation
from syntropic.evaluation import EvaluationExample, load_dataset, score_predictions


def _example(
    example_id: str,
    *,
    expected_status: str = "completed",
    line_items: list[dict] | None = None,
) -> EvaluationExample:
    return EvaluationExample(
        id=example_id,
        raw_text="Part number: VALVE-SS-050\nQuantity: 2",
        expected_line_items=line_items
        or [
            {
                "part_number": "VALVE-SS-050",
                "quantity": 2,
                "expected_catalog_part_number": "VALVE-SS-050",
            }
        ],
        expected_status=expected_status,
    )


def test_score_predictions_reports_extraction_and_stp_accuracy():
    examples = [
        _example("correct"),
        _example(
            "review",
            expected_status="flagged_for_review",
            line_items=[{"part_number": "UNKNOWN", "quantity": 1}],
        ),
    ]
    predictions = [
        {
            "extracted_data": {
                "line_items": [
                    {
                        "part_number": "VALVE-SS-050",
                        "quantity": 2,
                        "unit_of_measure": "EA",
                    }
                ]
            },
            "execution_log": ["ERP webhook queued."],
            "matched_catalog_items": [
                {"catalog_item": {"part_number": "VALVE-SS-050"}}
            ],
        },
        {
            "extracted_data": {"part_number": "UNKNOWN", "quantity": 1},
            "execution_log": ["Flagged for Human Review: No catalog match."],
        },
    ]

    report = score_predictions(examples, predictions)

    assert report == {
        "examples": 2,
        "exact_extraction_accuracy": 1.0,
        "line_item_precision": 1.0,
        "line_item_recall": 1.0,
        "catalog_match_accuracy": 1.0,
        "catalog_match_examples": 1,
        "expected_status_accuracy": 1.0,
        "stp_rate": 0.5,
        "stp_accuracy": 1.0,
        "automated_examples": 1,
        "correct_automated_examples": 1,
    }


def test_score_predictions_penalizes_incorrect_automatic_completion():
    example = _example("wrong", expected_status="flagged_for_review")
    prediction = {
        "extracted_data": {"part_number": "OTHER", "quantity": 1},
        "execution_log": ["ERP webhook queued."],
    }

    report = score_predictions([example], [prediction])

    assert report["stp_rate"] == 1.0
    assert report["stp_accuracy"] == 0.0
    assert report["expected_status_accuracy"] == 0.0


def test_score_predictions_rejects_mismatched_input_lengths():
    with pytest.raises(ValueError, match="one prediction"):
        score_predictions([_example("missing")], [])


def test_stp_accuracy_requires_the_expected_catalog_match():
    example = _example("wrong-match")
    prediction = {
        "extracted_data": {
            "line_items": [
                {
                    "part_number": "VALVE-SS-050",
                    "quantity": 2,
                    "unit_of_measure": "EA",
                }
            ]
        },
        "matched_catalog_items": [{"catalog_item": {"part_number": "VALVE-BR-050"}}],
        "execution_log": ["ERP webhook queued."],
    }

    report = score_predictions([example], [prediction])

    assert report["exact_extraction_accuracy"] == 1.0
    assert report["catalog_match_accuracy"] == 0.0
    assert report["stp_accuracy"] == 0.0


def test_load_dataset_requires_unique_ids_and_one_input_source(tmp_path):
    dataset = tmp_path / "examples.jsonl"
    row = {
        "id": "duplicate",
        "raw_text": "RFQ",
        "expected_line_items": [
            {
                "part_number": "X",
                "quantity": 1,
                "expected_catalog_part_number": "X",
            }
        ],
        "expected_status": "completed",
    }
    dataset.write_text(
        f"{json.dumps(row)}\n{json.dumps(row)}\n", encoding="utf-8"
    )

    with pytest.raises(ValueError, match="unique"):
        load_dataset(dataset)

    row["pdf_path"] = "quote.pdf"
    dataset.write_text(f"{json.dumps(row)}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="exactly one"):
        load_dataset(dataset)


def test_run_dataset_executes_and_scores_workflow_predictions(tmp_path, monkeypatch):
    dataset = tmp_path / "rfq.jsonl"
    dataset.write_text(
        json.dumps(
            {
                "id": "run-1",
                "raw_text": "Part number: VALVE-SS-050\nQuantity: 2",
                "expected_line_items": [
                    {
                        "part_number": "VALVE-SS-050",
                        "quantity": 2,
                        "unit_of_measure": "EA",
                        "expected_catalog_part_number": "VALVE-SS-050",
                    }
                ],
                "expected_status": "completed",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    class Graph:
        async def ainvoke(self, state, config):
            assert "VALVE-SS-050" in state["raw_input"]
            assert config["run_name"] == "rfq-evaluation"
            assert config["metadata"]["example_id"] == "run-1"
            return {
                "extracted_data": {
                    "line_items": [
                        {
                            "part_number": "VALVE-SS-050",
                            "quantity": 2,
                            "unit_of_measure": "EA",
                        }
                    ]
                },
                "execution_log": ["ERP webhook queued."],
                "matched_catalog_items": [
                    {"catalog_item": {"part_number": "VALVE-SS-050"}}
                ],
            }

    monkeypatch.setattr(evaluation, "build_syntropic_engine", Graph)

    report = asyncio.run(evaluation.run_dataset(dataset))

    assert report["examples"] == 1
    assert report["stp_accuracy"] == 1.0
