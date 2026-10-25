"""Offline evaluation of RFQ workflow decisions against labeled examples."""

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any, Literal, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from syntropic.core.engine import build_syntropic_engine
from syntropic.ingestion.parser import parse_pdf_document


class EvaluationLineItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    part_number: str = Field(min_length=1)
    quantity: int = Field(ge=1)
    unit_of_measure: str = "EA"
    expected_catalog_part_number: str | None = Field(default=None, min_length=1)


class EvaluationExample(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    raw_text: str | None = None
    pdf_path: str | None = None
    expected_line_items: list[EvaluationLineItem] = Field(min_length=1)
    expected_status: Literal["completed", "flagged_for_review", "pending_hitl"]

    @model_validator(mode="after")
    def has_one_input_source(self):
        if (self.raw_text is None) == (self.pdf_path is None):
            raise ValueError("Provide exactly one of raw_text or pdf_path.")
        if self.expected_status == "completed" and any(
            item.expected_catalog_part_number is None
            for item in self.expected_line_items
        ):
            raise ValueError(
                "Completed examples require an expected_catalog_part_number "
                "for each line item."
            )
        return self


def _line_item_key(
    item: dict[str, Any] | EvaluationLineItem,
) -> tuple[str, int, str]:
    values = item.model_dump() if isinstance(item, EvaluationLineItem) else item
    return (
        str(values.get("part_number", "")).strip().casefold(),
        int(values.get("quantity", 0) or 0),
        str(values.get("unit_of_measure", "EA")).strip().upper(),
    )


def predicted_workflow_status(prediction: dict[str, Any]) -> str:
    """Derive workflow status from structured state instead of log text."""
    if prediction.get("hitl_reason_code") == "below_confidence_floor":
        return "pending_hitl"
    if prediction.get("webhook_dispatch_requested"):
        return "completed"
    if any(
        str(message).startswith("Flagged for Human Review:")
        for message in prediction.get("execution_log", [])
    ):
        return "flagged_for_review"
    return "completed"


def score_predictions(
    examples: Sequence[EvaluationExample],
    predictions: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    if len(examples) != len(predictions):
        raise ValueError("There must be one prediction for every evaluation example.")
    if not examples:
        raise ValueError("The evaluation dataset must contain at least one example.")

    exact_extractions = 0
    expected_status_matches = 0
    automated_count = 0
    correct_automated_count = 0
    line_items_expected = 0
    line_items_predicted = 0
    line_items_correct = 0
    catalog_items_expected = 0
    catalog_items_correct = 0
    for example, prediction in zip(examples, predictions, strict=True):
        extracted = prediction.get("extracted_data") or {}
        actual_items = extracted.get("line_items") or (
            [extracted] if extracted.get("part_number") else []
        )
        expected_keys = [_line_item_key(item) for item in example.expected_line_items]
        actual_keys = [_line_item_key(item) for item in actual_items]
        exact = expected_keys == actual_keys
        exact_extractions += int(exact)
        line_items_expected += len(expected_keys)
        line_items_predicted += len(actual_keys)
        remaining = list(expected_keys)
        for key in actual_keys:
            if key in remaining:
                remaining.remove(key)
                line_items_correct += 1
        match_predictions = prediction.get("matched_catalog_items") or []
        if not match_predictions and prediction.get("matched_catalog_item"):
            match_predictions = [
                {"catalog_item": prediction["matched_catalog_item"]}
            ]
        catalog_correct_for_example = True
        for index, expected_item in enumerate(example.expected_line_items):
            expected_catalog_part_number = (
                expected_item.expected_catalog_part_number
            )
            if expected_catalog_part_number is None:
                continue
            catalog_items_expected += 1
            actual_match = (
                match_predictions[index].get("catalog_item")
                if index < len(match_predictions)
                else None
            )
            matched = (
                isinstance(actual_match, dict)
                and str(actual_match.get("part_number", "")).strip().casefold()
                == expected_catalog_part_number.strip().casefold()
            )
            catalog_items_correct += int(matched)
            catalog_correct_for_example = catalog_correct_for_example and matched

        predicted_status = predicted_workflow_status(prediction)
        status_correct = predicted_status == example.expected_status
        expected_status_matches += int(status_correct)
        if predicted_status == "completed":
            automated_count += 1
            correct_automated_count += int(
                status_correct and exact and catalog_correct_for_example
            )

    return {
        "examples": len(examples),
        "exact_extraction_accuracy": exact_extractions / len(examples),
        "line_item_precision": (
            line_items_correct / line_items_predicted if line_items_predicted else 0.0
        ),
        "line_item_recall": (
            line_items_correct / line_items_expected if line_items_expected else 0.0
        ),
        "catalog_match_accuracy": (
            catalog_items_correct / catalog_items_expected
            if catalog_items_expected
            else None
        ),
        "catalog_match_examples": catalog_items_expected,
        "expected_status_accuracy": expected_status_matches / len(examples),
        "stp_rate": automated_count / len(examples),
        "stp_accuracy": (
            correct_automated_count / automated_count if automated_count else 0.0
        ),
        "automated_examples": automated_count,
        "correct_automated_examples": correct_automated_count,
    }


def load_dataset(dataset_path: Path) -> list[EvaluationExample]:
    examples = []
    with dataset_path.open(encoding="utf-8") as source:
        for line_number, raw_line in enumerate(source, start=1):
            if not raw_line.strip():
                continue
            try:
                examples.append(EvaluationExample.model_validate_json(raw_line))
            except ValidationError as error:
                raise ValueError(
                    f"Invalid evaluation example at {dataset_path}:{line_number}: "
                    f"{error}"
                ) from error
    if not examples:
        raise ValueError(f"No evaluation examples found in {dataset_path}.")
    ids = [example.id for example in examples]
    if len(ids) != len(set(ids)):
        raise ValueError("Evaluation example ids must be unique.")
    return examples


async def run_dataset(dataset_path: Path) -> dict[str, Any]:
    examples = load_dataset(dataset_path)
    graph = build_syntropic_engine()
    predictions = []
    for example in examples:
        document_layout = None
        if example.pdf_path:
            pdf_path = (dataset_path.parent / example.pdf_path).resolve()
            raw_input, document_layout = await asyncio.to_thread(
                parse_pdf_document, pdf_path
            )
        else:
            raw_input = example.raw_text or ""
        initial_state = {
            "raw_input": raw_input,
            "extracted_data": {},
            "confidence_score": 0.0,
            "validation_errors": [],
            "retry_count": 0,
            "execution_log": [],
        }
        if document_layout is not None:
            initial_state["document_layout"] = document_layout
        predictions.append(
            await graph.ainvoke(
                initial_state,
                config={
                    "run_name": "rfq-evaluation",
                    "tags": ["rfq", "evaluation"],
                    "metadata": {
                        "dataset": dataset_path.stem,
                        "example_id": example.id,
                    },
                },
            )
        )
    return score_predictions(examples, predictions)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate RFQ straight-through processing against labeled JSONL."
    )
    parser.add_argument(
        "--dataset",
        type=Path,
        required=True,
        help="Path to a labeled UTF-8 JSONL evaluation dataset.",
    )
    parser.add_argument(
        "--min-stp-accuracy",
        type=float,
        default=0.994,
        help="Minimum required STP accuracy as a fraction (default: 0.994).",
    )
    args = parser.parse_args()
    if not 0.0 <= args.min_stp_accuracy <= 1.0:
        parser.error("--min-stp-accuracy must be between 0 and 1.")
    try:
        report = asyncio.run(run_dataset(args.dataset))
    except (OSError, ValueError) as error:
        parser.exit(2, f"Evaluation failed: {error}\n")

    print(json.dumps(report, indent=2, sort_keys=True))
    if report["stp_accuracy"] < args.min_stp_accuracy:
        print(
            f"STP accuracy {report['stp_accuracy']:.1%} is below the "
            f"required {args.min_stp_accuracy:.1%}."
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
