import re
from typing import Any, Dict, List, Optional

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import StateGraph, END, START
from pydantic import BaseModel, Field, ValidationError
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from syntropic.core.config import settings
from syntropic.core.matching.catalog import QdrantHybridCatalog
from syntropic.core.matching.margin_defender import (
    DECISION_VETO,
    MarginDefender,
    apply_margin_decisions,
    build_price_delta_telemetry,
)
from syntropic.core.matching.rebates import SPARebateInterceptor
from syntropic.core.schemas import CanonicalSKU
from syntropic.core.normalization import normalize_extracted_data
from syntropic.core.normalizer import TradeAttributeNormalizer
from syntropic.core.state import SyntropicState
from security.ast_veto import get_current_tenant, tenant_context


async def init_checkpointer_pool() -> AsyncConnectionPool:
    pool = AsyncConnectionPool(
        conninfo=settings.sync_database_url,
        max_size=20,
        kwargs={"autocommit": True, "row_factory": dict_row},
    )
    await pool.open()
    return pool


async def get_postgres_saver(pool: AsyncConnectionPool) -> AsyncPostgresSaver:
    saver = AsyncPostgresSaver(pool)
    await saver.setup()
    return saver


CONFIDENCE_THRESHOLD = 0.85
HITL_CONFIDENCE_FLOOR = 0.95
CATALOG_MATCH_THRESHOLD = 0.5
MAX_HEALING_RETRIES = 2

# Per-line-item graded-confidence penalties (V1 market-readiness remediation).
# The global document score is the minimum across all line items.
CONFIDENCE_PENALTIES = {
    "abbreviated_label": 0.04,
    "missing_unit_of_measure": 0.06,
    "validation_error": 0.25,  # per error, capped at two errors per line item
    "no_spatial_anchor": 0.03,  # only applied when a document layout is available
}

# ISO 4217 currency codes accepted during extraction.
_CURRENCY_CODES = (
    "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD",
    "CNY", "MXN", "INR", "SEK", "NOK", "DKK", "NZD",
)
_CURRENCY_SYMBOL_TO_CODE = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY"}


class ExtractedRFQ(BaseModel):
    part_number: str = Field(min_length=1)
    quantity: int = Field(gt=0)
    unit_price: Optional[float] = Field(default=None, gt=0)
    currency: Optional[str] = Field(default=None, min_length=3, max_length=3)


def _extraction_patterns(allow_abbreviations: bool) -> Dict[str, str]:
    """Labeled-field extraction patterns with abbreviated-label tracing."""
    part_labels = r"part\s+number"
    quantity_labels = r"quantity"
    if allow_abbreviations:
        part_labels = r"(?:(?P<part_abbrev>part|pn)|part\s+number)"
        quantity_labels = r"(?:(?P<qty_abbrev>qty)|quantity)"
    price_labels = r"unit\s+price|price|unit\s+cost"
    currency_code = "|".join(_CURRENCY_CODES)
    return {
        "part_number": (
            rf"\b(?:{part_labels})\s*[:#=]\s*"
            r"(?P<part_value>[A-Za-z0-9][A-Za-z0-9./_-]*)"
        ),
        "quantity": (
            rf"\b(?:{quantity_labels})\s*[:#=]\s*"
            r"(?P<qty_value>[+-]?\d+(?:\.\d+)?)"
            r"(?:[ \t]*(?P<qty_uom>[A-Za-z]+))?"
        ),
        "unit_price": (
            rf"\b(?:{price_labels})\s*[:#=]\s*"
            rf"(?:(?P<price_code>{currency_code})\s*)?"
            r"(?P<price_symbol>[$€£¥])?\s*"
            r"(?P<price_amount>\d+(?:\.\d+)?)\s*"
            rf"(?P<price_suffix>{currency_code})?\b"
        ),
    }


def _resolve_currency(
    prefix_code: Optional[str],
    symbol: Optional[str],
    suffix_code: Optional[str],
) -> Optional[str]:
    """Normalize an explicit ISO code or a currency symbol to ISO 4217."""
    code = (prefix_code or suffix_code or "").strip().upper()
    if code:
        return code
    if symbol:
        return _CURRENCY_SYMBOL_TO_CODE.get(symbol)
    return None


def _find_spatial_anchor(
    document_layout: Optional[Dict[str, Any]], part_number: Optional[str]
) -> List[Dict[str, Any]]:
    """Locate bounding-box provenance for a part number inside the document layout."""
    if not isinstance(document_layout, dict) or not part_number:
        return []
    needle = str(part_number).replace(" ", "").upper()
    if not needle:
        return []
    for block in document_layout.get("text_blocks") or []:
        text = str(block.get("text", "")).replace(" ", "").upper()
        if needle in text:
            provenance = block.get("provenance") or []
            if provenance:
                return provenance
    for table in document_layout.get("tables") or []:
        for cell in table.get("cells") or []:
            text = str(cell.get("text", "")).replace(" ", "").upper()
            if needle in text:
                provenance = cell.get("provenance") or []
                if provenance:
                    return provenance
    return []


def _score_line_item(
    *,
    used_abbreviated_label: bool,
    has_unit_of_measure: bool,
    validation_error_count: int,
    has_spatial_anchor: bool,
    document_layout_available: bool,
) -> float:
    """Grade one line item from 1.0 by subtracting documented penalties."""
    score = 1.0
    if used_abbreviated_label:
        score -= CONFIDENCE_PENALTIES["abbreviated_label"]
    if not has_unit_of_measure:
        score -= CONFIDENCE_PENALTIES["missing_unit_of_measure"]
    score -= CONFIDENCE_PENALTIES["validation_error"] * min(
        validation_error_count, 2
    )
    if document_layout_available and not has_spatial_anchor:
        score -= CONFIDENCE_PENALTIES["no_spatial_anchor"]
    return round(max(score, 0.0), 4)


def _extract_payload(
    raw_input: str,
    allow_abbreviations: bool = False,
    document_layout: Optional[Dict[str, Any]] = None,
) -> tuple[Dict[str, Any], float, list[str]]:
    """Parse labeled RFQ text into line items with per-item graded confidence.

    A score of 1.0 requires full labels, an explicit unit of measure, valid
    payload values, and (when a spatial document layout is available) a
    bounding-box anchor for the extracted part number.
    """
    patterns = _extraction_patterns(allow_abbreviations)
    part_matches = list(
        re.finditer(patterns["part_number"], raw_input, re.IGNORECASE)
    )
    if not part_matches:
        try:
            ExtractedRFQ.model_validate({})
        except ValidationError as error:
            validation_errors = [
                f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
                for item in error.errors()
            ]
            return {}, 0.0, validation_errors

    line_items: List[Dict[str, Any]] = []
    line_confidences: List[float] = []
    validation_errors: List[str] = []
    document_layout_available = isinstance(document_layout, dict)

    for index, part_match in enumerate(part_matches):
        block_end = (
            part_matches[index + 1].start()
            if index + 1 < len(part_matches)
            else len(raw_input)
        )
        block = raw_input[part_match.start():block_end]
        part_number = part_match.group("part_value")
        groups = part_match.groupdict()
        used_abbreviated_label = any(
            groups.get(name) for name in ("part_abbrev", "qty_abbrev")
        )

        quantity_match = re.search(patterns["quantity"], block, re.IGNORECASE)
        price_match = re.search(patterns["unit_price"], block, re.IGNORECASE)

        candidate: Dict[str, Any] = {"part_number": part_number}
        if quantity_match:
            candidate["quantity"] = quantity_match.group("qty_value")
            if quantity_match.group("qty_uom"):
                candidate["unit_of_measure"] = quantity_match.group("qty_uom")
        if price_match:
            candidate["unit_price"] = float(price_match.group("price_amount"))
            currency = _resolve_currency(
                price_match.group("price_code"),
                price_match.group("price_symbol"),
                price_match.group("price_suffix"),
            )
            if currency:
                candidate["currency"] = currency

        item_error_count = 0
        try:
            payload = ExtractedRFQ.model_validate(candidate)
            line_item = payload.model_dump()
            # Keep payloads clean: drop unquoted price/currency noise.
            if line_item.get("unit_price") is None:
                line_item.pop("unit_price", None)
            if line_item.get("currency") is None:
                line_item.pop("currency", None)
        except ValidationError as error:
            item_error_count = len(error.errors())
            line_item = dict(candidate)
            validation_errors.extend(
                f"line_items.{index}."
                f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
                for item in error.errors()
            )
        if candidate.get("unit_of_measure"):
            line_item["unit_of_measure"] = candidate["unit_of_measure"]

        spatial_anchor = _find_spatial_anchor(document_layout, part_number)
        if spatial_anchor:
            line_item["provenance"] = spatial_anchor

        line_item["extraction_confidence"] = _score_line_item(
            used_abbreviated_label=used_abbreviated_label,
            has_unit_of_measure=bool(candidate.get("unit_of_measure")),
            validation_error_count=item_error_count,
            has_spatial_anchor=bool(spatial_anchor),
            document_layout_available=document_layout_available,
        )
        line_items.append(line_item)
        line_confidences.append(line_item["extraction_confidence"])

    extracted = {"line_items": line_items}
    if line_items:
        extracted.update(line_items[0])
    global_confidence = round(min(line_confidences), 4) if line_items else 0.0
    return extracted, global_confidence, validation_errors


def normalization_node(state: SyntropicState) -> Dict[str, Any]:
    normalized, normalization_errors = normalize_extracted_data(
        state.get("extracted_data", {})
    )
    validation_errors = list(state.get("validation_errors", []))
    validation_errors.extend(normalization_errors)
    return {
        "extracted_data": normalized,
        "validation_errors": validation_errors,
        "confidence_score": (
            state.get("confidence_score", 0.0) if not normalization_errors else 0.0
        ),
        "execution_log": [
            "RFQ attributes normalized to canonical procurement units."
            if not normalization_errors
            else "RFQ normalization requires manual review."
        ],
    }


# Sentinel tenant used to seed the demo catalog when no tenant context is
# bound (local graph builds, evaluations). Production requests always carry
# a real tenant via process_rfq_document, so this fallback never fires there.
BOOTSTRAP_TENANT_ID = "__bootstrap__"


def _bootstrap_catalog() -> QdrantHybridCatalog:
    if get_current_tenant() is None:
        with tenant_context(BOOTSTRAP_TENANT_ID):
            return _bootstrap_catalog()
    catalog = QdrantHybridCatalog()
    if not settings.QDRANT_URL or settings.QDRANT_SEED_DEMO:
        catalog.index_catalog_items(_demo_catalog_items())
    return catalog


def _demo_catalog_items() -> List[Dict[str, Any]]:
    return [
        {
            "sku_id": "CAT-001",
            "part_number": "VALVE-SS-050",
            "description": "1/2 inch 316 Stainless Steel Ball Valve, Female NPT Thread",
            "unit_price": 42.00,
            "unit_cost": 28.00,
            "price_floor": 33.60,
            "category": "Valves",
            "currency": "USD",
            "rebate_schedule": {
                "rebate_pct": 0.05,
                "effective_from": "2026-01-01",
                "effective_until": "2026-12-31",
                "volume_tiers": [
                    {"min_qty": 100, "rebate_pct": 0.08},
                    {"min_qty": 500, "rebate_pct": 0.12},
                ],
            },
            "cost_sheet_updated": "2026-01-15",
        },
        {
            "sku_id": "CAT-002",
            "part_number": "VALVE-BR-050",
            "description": "1/2 inch Brass Gate Valve, Heavy Duty Duty Industrial",
            "unit_price": 18.50,
            "unit_cost": 12.10,
            "price_floor": 14.80,
            "category": "Valves",
            "currency": "USD",
            "rebate_schedule": None,
            "cost_sheet_updated": "2026-09-20",
        },
        {
            "sku_id": "CAT-003",
            "part_number": "PIPE-SS-100",
            "description": "1 inch Seamless Stainless Steel Pipe 316L Schedule 40",
            "unit_price": 110.00,
            "unit_cost": 77.00,
            "price_floor": 88.00,
            "category": "Pipes",
            "currency": "USD",
            "rebate_schedule": {
                "effective_from": "2026-12-31",
                "effective_until": "2026-01-01",
            },
            "cost_sheet_updated": "2026-10-01",
        },
    ]


# -------------------------------------------------------------------
# 1. NODES
# -------------------------------------------------------------------

def extraction_node(state: SyntropicState) -> Dict[str, Any]:
    """Extract labeled RFQ fields with per-line-item graded confidence."""
    print("\n[Syntropic Engine] Executing Ingestion & Extraction...")

    extracted_data, confidence_score, validation_errors = _extract_payload(
        state.get("raw_input", ""),
        document_layout=state.get("document_layout"),
    )
    return {
        "extracted_data": extracted_data,
        "confidence_score": confidence_score,
        "validation_errors": validation_errors,
        "execution_log": [
            f"Extraction completed with graded confidence: {confidence_score:.2f}"
        ],
    }


def self_healing_node(state: SyntropicState) -> Dict[str, Any]:
    """Retry extraction using common abbreviated RFQ field labels."""
    print("[Syntropic Engine] Self-Healing Loop Triggered! Retrying extraction...")

    retries = state.get("retry_count", 0) + 1
    extracted_data, confidence_score, validation_errors = _extract_payload(
        state.get("raw_input", ""),
        allow_abbreviations=True,
        document_layout=state.get("document_layout"),
    )
    return {
        "extracted_data": extracted_data,
        "confidence_score": confidence_score,
        "validation_errors": validation_errors,
        "retry_count": retries,
        "execution_log": [
            f"Extraction retry #{retries} completed with graded confidence: "
            f"{confidence_score:.2f}"
        ],
    }


def human_in_the_loop_node(state: SyntropicState) -> Dict[str, Any]:
    """Flags high-risk edge cases for human review with a structured reason."""
    print("[Syntropic Engine] CRITICAL: Routed to Human-in-the-Loop Queue for Manual Approval.")
    errors = state.get("validation_errors", [])
    confidence = state.get("confidence_score", 0.0)
    match_score = state.get("catalog_match_score")
    match_confirmed = state.get("catalog_match_confirmed")
    margin_report = state.get("margin_report", [])
    margin_vetoes = [
        entry for entry in margin_report if entry.get("decision") == DECISION_VETO
    ]

    if margin_vetoes:
        reason_code = "margin_veto"
        blocked = ", ".join(
            f"{entry.get('part_number') or 'unmatched line'} "
            f"[{entry.get('reason_code')}]"
            for entry in margin_vetoes
        )
        message = (
            f"Pending HITL review: margin defender blocked ERP push for "
            f"{len(margin_vetoes)} line item(s): {blocked}."
        )
    elif errors:
        reason_code = "validation_failed"
        message = f"Flagged for Human Review: {'; '.join(errors)}"
    elif float(confidence) < HITL_CONFIDENCE_FLOOR:
        reason_code = "below_confidence_floor"
        message = (
            f"Pending HITL review: extraction confidence {float(confidence):.2f} "
            f"is below the {HITL_CONFIDENCE_FLOOR:.2f} automation floor."
        )
    elif match_score is not None and match_confirmed is False:
        reason_code = "catalog_match_unconfirmed"
        message = (
            "Flagged for Human Review: no exact catalog part-number match "
            "was confirmed."
        )
    elif match_score is not None and float(match_score) < CATALOG_MATCH_THRESHOLD:
        reason_code = "catalog_match_below_threshold"
        message = (
            f"Flagged for Human Review: Catalog match score {float(match_score):.2f} "
            f"below threshold."
        )
    else:
        reason_code = "below_confidence_gate"
        message = (
            f"Flagged for Human Review: Confidence {float(confidence):.2f} "
            f"below threshold."
        )
    print(f"[Syntropic Engine] HITL reason code: {reason_code}")
    return {
        "hitl_reason_code": reason_code,
        "execution_log": [message],
    }


def catalog_match_node(
    state: SyntropicState, catalog: Optional[QdrantHybridCatalog] = None
) -> Dict[str, Any]:
    """Matches the extracted part numbers against the catalog and records results."""
    if catalog is None:
        catalog = _bootstrap_catalog()

    tenant_id = state.get("tenant_id") or get_current_tenant()
    if tenant_id is None:
        print(
            "[Syntropic Engine] catalog_match_node: no tenant in state or "
            "context; falling back to __bootstrap__ demo scope."
        )
        tenant_id = BOOTSTRAP_TENANT_ID

    extracted = state.get("extracted_data", {})
    line_items = extracted.get("line_items") or [extracted]
    raw_input = state.get("raw_input", "")
    if not line_items or not any(item.get("part_number") for item in line_items):
        return {
            "matched_catalog_item": None,
            "matched_catalog_items": [],
            "catalog_match_score": 0.0,
            "execution_log": ["Catalog match skipped: no part number available."],
        }

    matched_items = []
    execution_log = []
    for index, line_item in enumerate(line_items):
        part_number = str(line_item.get("part_number", "")).strip()
        if not part_number:
            matched_items.append({
                "extracted_item": line_item,
                "catalog_item": None,
                "rrf_score": 0.0,
                "match_confirmed": False,
            })
            execution_log.append(f"No part number available for line item {index + 1}.")
            continue

        description = str(
            line_item.get("description")
            or (raw_input if len(line_items) == 1 else part_number)
        )
        normalized_description, dimensional_specs = (
            TradeAttributeNormalizer.extract_dimensions(description)
        )
        normalized_line_item = dict(line_item)
        normalized_line_item["description"] = normalized_description
        if dimensional_specs:
            normalized_line_item["specifications"] = {
                **line_item.get("specifications", {}),
                **{
                    key: f"{value:g}" if isinstance(value, float) else str(value)
                    for key, value in dimensional_specs.items()
                },
            }

        quantity = int(line_item.get("quantity", 1) or 1)
        sku = CanonicalSKU(
            part_number=part_number,
            description=normalized_description,
            quantity=quantity,
            unit_of_measure=str(line_item.get("unit_of_measure", "EA")),
            specifications=normalized_line_item.get("specifications", {}),
            source_row_index=index,
            extraction_confidence=float(
                line_item.get("extraction_confidence", 0.9)
            ),
            currency=line_item.get("currency"),
            provenance=line_item.get("provenance") or [],
        )
        matches = catalog.match_sku(sku, top_k=3, tenant_id=tenant_id)
        if not matches:
            matched_items.append({
                "extracted_item": normalized_line_item,
                "catalog_item": None,
                "rrf_score": 0.0,
                "match_confirmed": False,
            })
            execution_log.append(f"No catalog match found for part number: {part_number}")
            continue

        normalized_part_number = part_number.replace(" ", "").upper()
        exact_match = next(
            (
                match
                for match in matches
                if str(match["catalog_item"].get("part_number", ""))
                .replace(" ", "")
                .upper()
                == normalized_part_number
            ),
            None,
        )
        # Auto-approval requires a confirmed exact part-number match; a
        # fuzzy candidate is only a suggestion surfaced for human review.
        match_confirmed = exact_match is not None
        best_match = exact_match or matches[0]
        best_item = best_match["catalog_item"]
        best_score = float(best_match["rrf_score"])
        matched_items.append({
            "extracted_item": normalized_line_item,
            "catalog_item": best_item,
            "rrf_score": best_score,
            "match_confirmed": match_confirmed,
        })
        execution_log.append(
            f"Catalog match for line item {index + 1}: "
            f"{best_item['part_number']} with score {best_score:.4f}."
        )
        print(
            f"[Syntropic Engine] Catalog match found: "
            f"{best_item['part_number']} ({best_score:.4f})"
        )

    first_match = matched_items[0]
    overall_score = min(item["rrf_score"] for item in matched_items)
    all_confirmed = all(item.get("match_confirmed") for item in matched_items)
    return {
        "matched_catalog_item": first_match["catalog_item"],
        "matched_catalog_items": matched_items,
        "catalog_match_score": overall_score,
        "catalog_match_confirmed": all_confirmed,
        "execution_log": execution_log,
    }


def spa_rebate_node(state: SyntropicState) -> Dict[str, Any]:
    """Intercept SPA rebate and cost-sheet discrepancies before ERP routing."""
    interceptor = SPARebateInterceptor()
    rebate_flags: List[Dict[str, Any]] = []
    execution_log: List[str] = []
    for match in state.get("matched_catalog_items", []):
        extracted_item = match.get("extracted_item") or {}
        catalog_item = match.get("catalog_item")
        for flag in interceptor.intercept_line_item(extracted_item, catalog_item):
            flag = dict(flag)
            flag["line_part_number"] = str(
                extracted_item.get("part_number", "")
            )
            rebate_flags.append(flag)
            execution_log.append(
                f"SPA rebate intercept [{flag['reason_code']}]: {flag['detail']}"
            )
    if not rebate_flags:
        execution_log.append(
            "SPA rebate intercept: no rebate discrepancies detected."
        )
    if rebate_flags:
        print(
            f"[Syntropic Engine] SPA rebate interceptor raised "
            f"{len(rebate_flags)} flag(s)."
        )
    return {
        "rebate_flags": rebate_flags,
        "execution_log": execution_log,
    }


def margin_defend_node(state: SyntropicState) -> Dict[str, Any]:
    """Veto / reprice / pass gate protecting margin before ERP routing.

    Evaluates every catalog-matched line item against the defender policy
    (hard breach below cost, soft breach below floor, fail-closed without a
    cost basis), applies any repricing to the extracted payload and match
    records, and records per-line decisions plus structured veto entries as
    margin telemetry.
    """
    defender = MarginDefender()
    matched_items = state.get("matched_catalog_items", [])
    report = defender.evaluate_matches(matched_items)

    execution_log: List[str] = []
    for entry in report:
        execution_log.append(
            f"Margin defend [{entry['reason_code']}]: {entry['detail']}"
        )

    vetoes = [entry for entry in report if entry.get("decision") == DECISION_VETO]
    repriced = [entry for entry in report if entry.get("decision") == "reprice"]

    update: Dict[str, Any] = {
        "margin_report": report,
        "margin_veto_log_entries": vetoes,
        "execution_log": execution_log,
    }

    if repriced:
        extracted_data = dict(state.get("extracted_data", {}))
        apply_margin_decisions(extracted_data, matched_items, report)
        update["extracted_data"] = extracted_data
        update["matched_catalog_items"] = matched_items
        # Delta telemetry travels with the repricing: quoted vs pushed vs
        # cost vs floor for every corrected line.
        update["price_deltas"] = build_price_delta_telemetry(
            extracted_data, matched_items, report
        )

    if vetoes:
        update["hitl_reason_code"] = "margin_veto"
        print(
            f"[Syntropic Engine] MARGIN VETO: {len(vetoes)} line item(s) "
            "blocked from ERP push."
        )
    elif repriced:
        print(
            f"[Syntropic Engine] Margin defender repriced "
            f"{len(repriced)} line item(s) to floor."
        )
    return update


def margin_defend_router(state: SyntropicState) -> str:
    """Route after margin defense.

    Any margin veto overrides every other signal: the RFQ is parked for
    human review and nothing reaches ERP. Otherwise the standard
    catalog-match routing (confidence floor + match confirmation) applies.
    """
    if any(
        entry.get("decision") == DECISION_VETO
        for entry in state.get("margin_report", [])
    ):
        return "review"
    return catalog_match_router(state)


def catalog_match_router(state: SyntropicState) -> str:
    """Route after catalog matching and SPA interception.

    A document only auto-approves when the graded confidence meets the HITL
    floor AND every line item confirmed an exact catalog part-number match;
    otherwise it is parked for human review. Rank-based RRF scores alone
    cannot discriminate (they saturate for any top-ranked candidate), so the
    semantic part-number confirmation is the load-bearing gate.
    """
    if float(state.get("confidence_score", 0.0)) < HITL_CONFIDENCE_FLOOR:
        return "review_floor"
    if not state.get("catalog_match_confirmed", False):
        return "review"
    match_score = float(state.get("catalog_match_score", 0.0))
    return "approve" if match_score >= CATALOG_MATCH_THRESHOLD else "review"


def erp_sync_node(state: SyntropicState) -> Dict[str, Any]:
    """Normalize approved data and request durable asynchronous ERP delivery."""
    if (
        not CONFIDENCE_THRESHOLD <= state.get("confidence_score", 0.0) <= 1.0
        or state.get("validation_errors")
    ):
        raise ValueError("Refusing ERP push for unapproved or invalid RFQ data.")
    extracted_data = dict(state.get("extracted_data", {}))
    source_items = extracted_data.get("line_items") or [extracted_data]
    try:
        for item in source_items:
            ExtractedRFQ.model_validate(item)
    except ValidationError as error:
        raise ValueError("Refusing ERP push for invalid RFQ data.") from error

    normalized_items = []
    for source_item in source_items:
        item = dict(source_item)
        raw_uom = item.get("unit_of_measure", "EA")
        raw_description = str(item.get("description") or "")
        item["unit_of_measure"] = TradeAttributeNormalizer.normalize_uom(
            str(raw_uom)
        )
        normalized_description, specifications = (
            TradeAttributeNormalizer.extract_dimensions(raw_description)
        )
        if raw_description:
            item["description"] = normalized_description
        if specifications:
            existing_specifications = item.get("specifications") or {}
            if not isinstance(existing_specifications, dict):
                raise ValueError(
                    "Refusing ERP sync for invalid item specifications."
                )
            item["specifications"] = {
                **existing_specifications,
                **{
                    key: f"{value:g}" if isinstance(value, float) else str(value)
                    for key, value in specifications.items()
                },
            }
        normalized_items.append(item)

    if extracted_data.get("line_items"):
        extracted_data["line_items"] = normalized_items
    if normalized_items:
        extracted_data.update(normalized_items[0])

    matched_items = state.get("matched_catalog_items", [])
    matched_item = state.get("matched_catalog_item")
    matched_part_numbers = [
        str(item["catalog_item"].get("part_number", ""))
        for item in matched_items
        if item.get("catalog_item")
    ]
    if matched_part_numbers:
        message = (
            "ERP webhook queued for catalog items: "
            f"{', '.join(matched_part_numbers)}."
        )
    elif matched_item is not None:
        message = f"ERP webhook queued for catalog item {matched_item.get('part_number')}."
    else:
        message = "ERP webhook queued without a catalog match."
    print("[Syntropic Engine] Payload approved; ERP webhook queued for delivery.")
    return {
        "extracted_data": extracted_data,
        "webhook_dispatch_requested": True,
        "execution_log": [message],
    }


erp_push_node = erp_sync_node

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

    payload_is_valid = _health_gate_payload_is_valid(state)

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


def _health_gate_payload_is_valid(state: SyntropicState) -> bool:
    try:
        ExtractedRFQ.model_validate(state.get("extracted_data", {}))
        return not state.get("validation_errors", [])
    except ValidationError:
        return False


def health_gate_node(state: SyntropicState) -> Dict[str, Any]:
    """Record the health-gate inputs and routing decision as a traced node."""
    decision = syntropic_health_router(state)
    score = float(state.get("confidence_score", 0.0))
    retries = state.get("retry_count", 0)
    payload_is_valid = _health_gate_payload_is_valid(state)

    message = (
        f"Health gate decision: {decision} "
        f"(confidence {score:.2f}/{CONFIDENCE_THRESHOLD:.2f}, "
        f"payload {'valid' if payload_is_valid else 'invalid'}, "
        f"retry {retries}/{MAX_HEALING_RETRIES})."
    )
    return {
        "health_gate_decision": decision,
        "health_gate_score": score,
        "health_gate_threshold": CONFIDENCE_THRESHOLD,
        "health_gate_payload_valid": payload_is_valid,
        "execution_log": [message],
    }


def health_gate_router(state: SyntropicState) -> str:
    """Route using the decision recorded by the observable health-gate node."""
    decision = state.get("health_gate_decision")
    if decision not in {"approve", "heal", "review"}:
        raise ValueError("Health gate node did not record a valid decision.")
    return decision


# -------------------------------------------------------------------
# 3. GRAPH COMPOSITION & COMPILATION
# -------------------------------------------------------------------

def build_syntropic_engine(checkpointer: Any = None):
    settings.configure_langsmith_tracing()
    workflow = StateGraph(SyntropicState)
    catalog = _bootstrap_catalog()

    # Add Execution Nodes
    workflow.add_node("extraction", extraction_node)
    workflow.add_node("self_healing", self_healing_node)
    workflow.add_node("normalize", normalization_node)
    workflow.add_node("health_gate", health_gate_node)
    workflow.add_node("catalog_match", lambda state: catalog_match_node(state, catalog))
    workflow.add_node("spa_rebate", spa_rebate_node)
    workflow.add_node("margin_defend", margin_defend_node)
    workflow.add_node("hitl_queue", human_in_the_loop_node)
    workflow.add_node("erp_push", erp_sync_node)

    # Define Entry Edge
    workflow.add_edge(START, "extraction")
    workflow.add_edge("extraction", "normalize")

    # Revalidate normalized attributes after both initial and healing extraction.
    workflow.add_edge("self_healing", "normalize")
    workflow.add_edge("normalize", "health_gate")
    workflow.add_conditional_edges(
        "health_gate",
        health_gate_router,
        {
            "approve": "catalog_match",
            "heal": "self_healing",
            "review": "hitl_queue"
        }
    )

    # Intercept SPA rebate discrepancies between catalog matching and
    # routing, then enforce margin policy before anything reaches ERP.
    workflow.add_edge("catalog_match", "spa_rebate")
    workflow.add_edge("spa_rebate", "margin_defend")
    workflow.add_conditional_edges(
        "margin_defend",
        margin_defend_router,
        {
            "approve": "erp_push",
            "review_floor": "hitl_queue",
            "review": "hitl_queue"
        }
    )

    workflow.add_edge("erp_push", END)
    workflow.add_edge("hitl_queue", END)

    return workflow.compile(checkpointer=checkpointer)


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
