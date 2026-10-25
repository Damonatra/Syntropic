from typing import TypedDict, Annotated, List, Dict, Any, Literal, NotRequired
import operator

class SyntropicState(TypedDict):
    """
    Syntropic Core State Object.
    Tracks payload data alongside global health metrics and execution provenance.
    """
    raw_input: str
    extracted_data: Dict[str, Any]
    document_layout: NotRequired[Dict[str, Any]]
    webhook_dispatch_requested: NotRequired[bool]

    # Global Health Metrics (Syntropic Enhancement)
    confidence_score: float  # 0.0 to 1.0 threshold scale
    validation_errors: List[str]

    # Catalog matching results
    matched_catalog_item: NotRequired[Dict[str, Any] | None]
    matched_catalog_items: NotRequired[List[Dict[str, Any]]]
    catalog_match_score: NotRequired[float]
    # True only when every line item confirmed an exact catalog part number.
    catalog_match_confirmed: NotRequired[bool]

    # Margin telemetry from the SPA rebate interceptor
    rebate_flags: NotRequired[List[Dict[str, Any]]]

    # Structured human-review reason (e.g. 'below_confidence_floor')
    hitl_reason_code: NotRequired[str]
    health_gate_decision: NotRequired[Literal["approve", "heal", "review"]]
    health_gate_score: NotRequired[float]
    health_gate_threshold: NotRequired[float]
    health_gate_payload_valid: NotRequired[bool]

    # State Circuit Breaker & Provenance
    retry_count: int
    execution_log: Annotated[List[str], operator.add]
