# syntropic/core/tracing.py
import os
from langsmith import traceable
from syntropic.core.config import settings

# Export telemetry context to environment
os.environ["LANGSMITH_TRACING"] = str(settings.LANGSMITH_TRACING).lower()
os.environ["LANGSMITH_API_KEY"] = settings.LANGSMITH_API_KEY
os.environ["LANGSMITH_PROJECT"] = settings.LANGSMITH_PROJECT

@traceable(name="syntropic_confidence_evaluator", run_type="chain")
def evaluate_confidence_score(extracted_skus: list, matched_catalog: list) -> float:
    """Traced helper function that logs confidence metric calculation to LangSmith."""
    if not extracted_skus:
        return 0.0

    total_score = sum(item.get("extraction_confidence", 0.0) for item in extracted_skus)
    avg_score = total_score / len(extracted_skus)
    return round(avg_score, 4)