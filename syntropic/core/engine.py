import re
from typing import Any, Dict, List, Optional

from langgraph.graph import StateGraph, END, START
from pydantic import BaseModel, Field, ValidationError
from syntropic.matching.catalog import QdrantHybridCatalog
from syntropic.core.schemas import CanonicalSKU
from syntropic.core.state import SyntropicState

CONFIDENCE_THRESHOLD = 0.85
CATALOG_MATCH_THRESHOLD = 0.5
MAX_HEALING_RETRIES = 2


class ExtractedRFQ(BaseModel):
    part_number: str = Field(min_length=1)
    quantity: int = Field(gt=0)


def _extract_payload(raw_input: str, allow_abbreviations: bool = False) -> tuple[Dict[str, Any], float, list[str]]:
    """Parse labeled RFQ text; a score of 1.0 means rule validation passed."""
    part_labels = r"part\s+number"
    quantity_labels = r"quantity"
    if allow_abbreviations:
        part_labels = r"part\s+number|part|pn"
        quantity_labels = r"quantity|qty"

    patterns = {
        "part_number": rf"\b(?:{part_labels})\s*[:#=]\s*([A-Za-z0-9][A-Za-z0-9./_-]*)",
        "quantity": rf"\b(?:{quantity_labels})\s*[:#=]\s*([+-]?\d+(?:\.\d+)?)",
    }
    extracted = {}
    for field, pattern in patterns.items():
        match = re.search(pattern, raw_input, re.IGNORECASE)
        if match:
            extracted[field] = match.group(1)

    try:
        payload = ExtractedRFQ.model_validate(extracted)
    except ValidationError as error:
        validation_errors = [
            f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
            for item in error.errors()
        ]
        return extracted, 0.0, validation_errors

    return payload.model_dump(), 1.0, []


def _bootstrap_catalog() -> QdrantHybridCatalog:
    catalog = QdrantHybridCatalog(location=":memory:")
    catalog.index_catalog_items([
        {
            "sku_id": "CAT-001",
            "part_number": "VALVE-SS-050",
            "description": "1/2 inch 316 Stainless Steel Ball Valve, Female NPT Thread",
            "unit_price": 42.00,
            "category": "Valves",
        },
        {
            "sku_id": "CAT-002",
            "part_number": "VALVE-BR-050",
            "description": "1/2 inch Brass Gate Valve, Heavy Duty Duty Industrial",
            "unit_price": 18.50,
            "category": "Valves",
        },
        {
            "sku_id": "CAT-003",
            "part_number": "PIPE-SS-100",
            "description": "1 inch Seamless Stainless Steel Pipe 316L Schedule 40",
            "unit_price": 110.00,
            "category": "Pipes",
        },
    ])
    return catalog

# -------------------------------------------------------------------
# 1. NODES (Replace the text parser with PDF/OCR extraction in production)
# -------------------------------------------------------------------

def extraction_node(state: SyntropicState) -> Dict[str, Any]:
    """Extract labeled RFQ fields from plain text input."""
    print("\n[Syntropic Engine] Executing Ingestion & Extraction...")

    extracted_data, confidence_score, validation_errors = _extract_payload(
        state.get("raw_input", "")
    )
    return {
        "extracted_data": extracted_data,
        "confidence_score": confidence_score,
        "validation_errors": validation_errors,
        "execution_log": [
            f"Extraction completed with confidence: {confidence_score:.2f}"
        ],
    }

def self_healing_node(state: SyntropicState) -> Dict[str, Any]:
    """Retry extraction using common abbreviated RFQ field labels."""
    print("[Syntropic Engine] Self-Healing Loop Triggered! Retrying extraction...")

    retries = state.get("retry_count", 0) + 1
    extracted_data, confidence_score, validation_errors = _extract_payload(
        state.get("raw_input", ""), allow_abbreviations=True
    )
    return {
        "extracted_data": extracted_data,
        "confidence_score": confidence_score,
        "validation_errors": validation_errors,
        "retry_count": retries,
        "execution_log": [
            f"Extraction retry #{retries} completed with confidence: {confidence_score:.2f}"
        ],
    }

def human_in_the_loop_node(state: SyntropicState) -> Dict[str, Any]:
    """Flags high-risk edge cases to the Streamlit/FastHTML review queue."""
    print("[Syntropic Engine] CRITICAL: Routed to Human-in-the-Loop Queue for Manual Approval.")
    errors = state.get("validation_errors", [])
    if errors:
        reason = "; ".join(errors)
    elif state.get("catalog_match_score", 1.0) < CATALOG_MATCH_THRESHOLD:
        reason = f"Catalog match score {state.get('catalog_match_score', 0.0):.2f} below threshold."
    else:
        reason = f"Confidence {state.get('confidence_score', 0.0):.2f} below threshold."
    return {
        "execution_log": [f"Flagged for Human Review: {reason}"]
    }

def catalog_match_node(state: SyntropicState, catalog: Optional[QdrantHybridCatalog] = None) -> Dict[str, Any]:
    """Matches the extracted part number against the catalog and records the best result."""
    if catalog is None:
        catalog = _bootstrap_catalog()

    extracted = state.get("extracted_data", {})
    part_number = str(extracted.get("part_number", "")).strip()
    quantity = int(extracted.get("quantity", 1) or 1)
    raw_input = state.get("raw_input", "")

    if not part_number:
        return {
            "matched_catalog_item": None,
            "catalog_match_score": 0.0,
            "execution_log": ["Catalog match skipped: no part number available."],
        }

    sku = CanonicalSKU(
        part_number=part_number,
        description=(raw_input or part_number),
        quantity=quantity,
        unit_of_measure="EA",
        source_row_index=0,
        extraction_confidence=0.9,
    )

    matches = catalog.match_sku(sku, top_k=1)
    if not matches:
        return {
            "matched_catalog_item": None,
            "catalog_match_score": 0.0,
            "execution_log": [f"No catalog match found for part number: {part_number}"],
        }

    best_match = matches[0]
    best_item = best_match["catalog_item"]
    best_score = float(best_match["rrf_score"])

    print(f"[Syntropic Engine] Catalog match found: {best_item['part_number']} ({best_score:.4f})")
    return {
        "matched_catalog_item": best_item,
        "catalog_match_score": best_score,
        "execution_log": [
            f"Catalog match confirmed for {best_item['part_number']} with score {best_score:.4f}."
        ],
    }


def catalog_match_router(state: SyntropicState) -> str:
    """Routes only when a catalog match passes the minimum confidence threshold."""
    match_score = float(state.get("catalog_match_score", 0.0))
    return "approve" if match_score >= CATALOG_MATCH_THRESHOLD else "review"


def erp_push_node(state: SyntropicState) -> Dict[str, Any]:
    """Pushes high-confidence parsed data into ERP system."""
    if (
        not CONFIDENCE_THRESHOLD <= state.get("confidence_score", 0.0) <= 1.0
        or state.get("validation_errors")
    ):
        raise ValueError("Refusing ERP push for unapproved or invalid RFQ data.")
    try:
        ExtractedRFQ.model_validate(state.get("extracted_data", {}))
    except ValidationError as error:
        raise ValueError("Refusing ERP push for invalid RFQ data.") from error

    matched_item = state.get("matched_catalog_item")
    print("[Syntropic Engine] SUCCESS: Payload approved. Pushing to ERP catalog.")
    return {
        "execution_log": [
            "Payload successfully committed to ERP." if matched_item is None else f"Payload matched catalog item {matched_item.get('part_number')} before ERP commit."
        ]
    }

# -------------------------------------------------------------------
# 2. DYNAMIC HEALTH ROUTER (SYN TROPIC ENHANCEMENT)
# -------------------------------------------------------------------

def syntropic_health_router(state: SyntropicState) -> str:
    """
    Evaluates global confidence metric on state transition.
    Reroutes execution dynamically based on the 0.85 threshold rule.
    """
    score = state.get("confidence_score", 0.0)
    retries = state.get("retry_count", 0)

    try:
        ExtractedRFQ.model_validate(state.get("extracted_data", {}))
        payload_is_valid = not state.get("validation_errors", [])
    except ValidationError:
        payload_is_valid = False

    print(
        f"\n--- [Health Router Audit] Score: {score:.2f} | "
        f"Threshold: {CONFIDENCE_THRESHOLD:.2f} | Retries: {retries} ---"
    )

    if CONFIDENCE_THRESHOLD <= score <= 1.0 and payload_is_valid:
        return "approve"
    elif retries < MAX_HEALING_RETRIES:
        return "heal"
    else:
        return "review"

# -------------------------------------------------------------------
# 3. GRAPH COMPOSITION & COMPILATION
# -------------------------------------------------------------------

def build_syntropic_engine():
    workflow = StateGraph(SyntropicState)
    catalog = _bootstrap_catalog()

    # Add Execution Nodes
    workflow.add_node("extraction", extraction_node)
    workflow.add_node("self_healing", self_healing_node)
    workflow.add_node("catalog_match", lambda state: catalog_match_node(state, catalog))
    workflow.add_node("hitl_queue", human_in_the_loop_node)
    workflow.add_node("erp_push", erp_push_node)

    # Define Entry Edge
    workflow.add_edge(START, "extraction")

    # Add Conditional Health Routing Edges after Extraction
    workflow.add_conditional_edges(
        "extraction",
        syntropic_health_router,
        {
            "approve": "catalog_match",
            "heal": "self_healing",
            "review": "hitl_queue"
        }
    )

    # Add Conditional Health Routing Edges after Self-Healing
    workflow.add_conditional_edges(
        "self_healing",
        syntropic_health_router,
        {
            "approve": "catalog_match",
            "heal": "self_healing",
            "review": "hitl_queue"
        }
    )

    workflow.add_conditional_edges(
        "catalog_match",
        catalog_match_router,
        {
            "approve": "erp_push",
            "review": "hitl_queue"
        }
    )

    workflow.add_edge("erp_push", END)
    workflow.add_edge("hitl_queue", END)

    return workflow.compile()

if __name__ == "__main__":
    app = build_syntropic_engine()

    # Test Run
    initial_state = {
        "raw_input": "PN: VALVE-1/2-SS\nQty: 500",
        "extracted_data": {},
        "confidence_score": 0.0,
        "validation_errors": [],
        "retry_count": 0,
        "execution_log": []
    }

    result = app.invoke(initial_state)
    print("\n--- FINAL EXECUTION LOG ---")
    for log in result["execution_log"]:
        print(f"• {log}")
