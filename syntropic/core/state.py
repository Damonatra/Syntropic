from typing import TypedDict, Annotated, List, Dict, Any
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

    # State Circuit Breaker & Provenance
    retry_count: int
    execution_log: Annotated[List[str], operator.add]
