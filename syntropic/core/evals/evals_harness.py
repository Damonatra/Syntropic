# syntropic/evals/eval_harness.py

import asyncio

from langsmith import Client
from langsmith.evaluation import evaluate

from syntropic.core.config import settings
from syntropic.core.schemas import CanonicalSKU
from syntropic.matching.catalog import QdrantHybridCatalog

# Ground Truth Dataset Example
GOLDEN_DATASET = [
    {
        "inputs": {"raw_text": "1/2 inch 316 stainless steel ball valve", "raw_part": "VLV-SS-050"},
        "outputs": {"canonical_part": "VALVE-SS-050", "uom": "EA"}
    },
    {
        "inputs": {"raw_text": "2-Inch Class 150 Stainless Steel 304 Slip-On Flange", "raw_part": "APX-FLG-304-02"},
        "outputs": {"canonical_part": "FLG-SS-304-02", "uom": "EA"}
    }
]


# Custom Evaluator: Target Part Number Match Precision
def part_number_exact_match_evaluator(run, example) -> dict:
    """Evaluates whether matched catalog SKU equals ground truth SKU."""
    target_part = example.outputs.get("canonical_part")
    predicted_sku = run.outputs.get("matched_part_number")

    score = 1.0 if target_part == predicted_sku else 0.0
    return {"key": "part_number_precision", "score": score}


# Target Pipeline Function for Evaluation
def target_matching_pipeline(inputs: dict) -> dict:
    catalog = QdrantHybridCatalog(location=":memory:")

    sku = CanonicalSKU(
        part_number=inputs["raw_part"],
        description=inputs["raw_text"],
        quantity=1,
        unit_of_measure="EA",
        source_row_index=1,
        extraction_confidence=0.9
    )

    matches = catalog.match_sku(sku, top_k=1)
    matched_part = matches[0]["catalog_item"]["part_number"] if matches else "NO_MATCH"

    return {"matched_part_number": matched_part}


def run_evaluation_benchmark():
    """Uploads ground-truth dataset and executes evaluation suite in LangSmith."""
    settings.configure_langsmith_tracing()
    client = Client()
    dataset_name = "syntropic_golden_rfq_benchmark"

    # Create dataset if it does not exist
    if not client.has_dataset(dataset_name=dataset_name):
        dataset = client.create_dataset(dataset_name=dataset_name, description="Ground truth RFQ extraction benchmark.")
        for item in GOLDEN_DATASET:
            client.create_example(inputs=item["inputs"], outputs=item["outputs"], dataset_id=dataset.id)

    print(f"Executing LangSmith Evaluation for dataset: '{dataset_name}'...")

    results = evaluate(
        target_matching_pipeline,
        data=dataset_name,
        evaluators=[part_number_exact_match_evaluator],
        experiment_prefix="sprint3-catalog-match-eval"
    )

    print("\n--- EVALUATION COMPLETE ---")
    print(f"Results viewable in LangSmith Project: {settings.LANGSMITH_PROJECT}")


if __name__ == "__main__":
    run_evaluation_benchmark()