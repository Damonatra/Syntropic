from typing import TypedDict, Annotated, List, Dict, Any, NotRequired
import operator

class SyntropicState(TypedDict):
    """
    Syntropic Core State Object.
    Tracks payload data alongside global health metrics and execution provenance.
    """
    raw_input: str
    extracted_data: Dict[str, Any]

    # Global Health Metrics (Syntropic Enhancement)
    confidence_score: float  # 0.0 to 1.0 threshold scale
    validation_errors: List[str]

    # Catalog matching results
    matched_catalog_item: NotRequired[Dict[str, Any] | None]
    matched_catalog_items: NotRequired[List[Dict[str, Any]]]
    catalog_match_score: NotRequired[float]

    # State Circuit Breaker & Provenance
    retry_count: int
    execution_log: Annotated[List[str], operator.add]
