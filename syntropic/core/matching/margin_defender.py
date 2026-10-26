"""Margin enforcement for catalog-matched line items (Layer 3, Vector 4).

The MarginDefender is the price-protection gate that runs between catalog
matching and ERP push. Policy is deliberately two-tier:

  - HARD BREACH  quoted price below unit_cost  -> veto; ERP push is refused
    and the RFQ is parked for human review. A machine must never price a
    deal below what the goods cost.
  - SOFT BREACH  unit_cost <= quoted < floor   -> repriced up to the floor
    when repricing is enabled (MARGIN_REPRICE_ENABLED); vetoed otherwise.
    The original quote and the pushed price both land in delta telemetry.
  - NO COST BASIS  catalog entry missing/zero unit_cost -> fail-closed veto.
    Margin that cannot be verified is treated as margin at risk.
  - NO QUOTED PRICE  line item carries no price -> pass with a note; ERP-side
    pricing applies and there is nothing to defend yet.

Every evaluated line item produces a decision record carrying the full price
picture (quoted / effective / cost / floor / margins) so the approval path
can emit delta telemetry without recomputing anything.
"""

from typing import Any, Dict, List, Optional

from syntropic.core.config import settings

REASON_NEGATIVE_MARGIN = "MARGIN_NEGATIVE"
REASON_BELOW_FLOOR = "MARGIN_BELOW_FLOOR"
REASON_REPRICED_TO_FLOOR = "REPRICED_TO_FLOOR"
REASON_NO_COST_BASIS = "NO_COST_BASIS"
REASON_NO_QUOTED_PRICE = "NO_QUOTED_PRICE"
REASON_NO_CATALOG_MATCH = "NO_CATALOG_MATCH"
REASON_MARGIN_OK = "MARGIN_OK"

DECISION_PASS = "pass"
DECISION_VETO = "veto"
DECISION_REPRICE = "reprice"

# Tolerance for floating-point price comparisons (half a cent).
PRICE_EPSILON = 0.005


class MarginDefender:
    """Evaluates quoted prices against catalog cost and floor policy."""

    def __init__(
        self,
        margin_floor_pct: Optional[float] = None,
        reprice_enabled: Optional[bool] = None,
    ) -> None:
        self.margin_floor_pct = (
            settings.MARGIN_FLOOR_PCT
            if margin_floor_pct is None
            else float(margin_floor_pct)
        )
        self.reprice_enabled = (
            settings.MARGIN_REPRICE_ENABLED
            if reprice_enabled is None
            else bool(reprice_enabled)
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def floor_price_for(self, catalog_item: Optional[Dict[str, Any]]) -> Optional[float]:
        """Explicit catalog floor wins; otherwise derive it from unit_cost."""
        if not isinstance(catalog_item, dict):
            return None
        explicit = _as_float(catalog_item.get("price_floor"))
        if explicit is not None and explicit > 0:
            return round(explicit, 2)
        cost = _as_float(catalog_item.get("unit_cost"))
        if cost is None or cost <= 0:
            return None
        if self.margin_floor_pct <= 0 or self.margin_floor_pct >= 1:
            return round(cost, 2)
        return round(cost / (1.0 - self.margin_floor_pct), 2)

    def evaluate_line_item(
        self,
        extracted_item: Optional[Dict[str, Any]],
        catalog_item: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Return one decision record for a single matched line item."""
        extracted = extracted_item if isinstance(extracted_item, dict) else {}
        catalog = catalog_item if isinstance(catalog_item, dict) else None

        part_number = str(
            (catalog or {}).get("part_number") or extracted.get("part_number", "")
        )
        sku_id = str((catalog or {}).get("sku_id", ""))
        quantity = _as_positive_int(extracted.get("quantity"))

        quoted_price = _as_float(extracted.get("unit_price"))
        unit_cost = _as_float((catalog or {}).get("unit_cost"))
        price_floor = self.floor_price_for(catalog)

        record = {
            "part_number": part_number,
            "sku_id": sku_id,
            "quantity": quantity,
            "quoted_price": quoted_price,
            "effective_price": quoted_price,
            "unit_cost": unit_cost,
            "price_floor": price_floor,
            "quoted_margin_pct": _margin_pct(quoted_price, unit_cost),
            "effective_margin_pct": _margin_pct(quoted_price, unit_cost),
            "repriced": False,
            "decision": DECISION_PASS,
            "reason_code": REASON_MARGIN_OK,
            "detail": "",
        }

        if catalog is None:
            record.update(
                {
                    "reason_code": REASON_NO_CATALOG_MATCH,
                    "detail": (
                        "line item has no catalog match; margin policy is not "
                        "applicable and routing is governed by match confirmation"
                    ),
                }
            )
            return record

        if quoted_price is None:
            record.update(
                {
                    "reason_code": REASON_NO_QUOTED_PRICE,
                    "detail": (
                        "line item carries no quoted price; ERP-side pricing "
                        "applies and no margin breach can be evaluated"
                    ),
                }
            )
            return record

        if unit_cost is None or unit_cost <= 0:
            record.update(
                {
                    "decision": DECISION_VETO,
                    "reason_code": REASON_NO_COST_BASIS,
                    "detail": (
                        f"catalog entry {part_number} carries no usable unit "
                        "cost; margin cannot be verified and the push is "
                        "blocked (fail-closed)"
                    ),
                }
            )
            return record

        if quoted_price < unit_cost - PRICE_EPSILON:
            record.update(
                {
                    "decision": DECISION_VETO,
                    "reason_code": REASON_NEGATIVE_MARGIN,
                    "detail": (
                        f"quoted {quoted_price:.2f} is below unit cost "
                        f"{unit_cost:.2f} for {part_number}; ERP push vetoed"
                    ),
                }
            )
            return record

        if price_floor is None:
            record.update(
                {
                    "reason_code": REASON_MARGIN_OK,
                    "detail": (
                        f"quoted {quoted_price:.2f} clears unit cost "
                        f"{unit_cost:.2f} for {part_number}; no floor "
                        "configured"
                    ),
                }
            )
            return record

        if quoted_price < price_floor - PRICE_EPSILON:
            if self.reprice_enabled:
                record.update(
                    {
                        "decision": DECISION_REPRICE,
                        "effective_price": price_floor,
                        "effective_margin_pct": _margin_pct(price_floor, unit_cost),
                        "repriced": True,
                        "reason_code": REASON_REPRICED_TO_FLOOR,
                        "detail": (
                            f"quoted {quoted_price:.2f} is below the "
                            f"{price_floor:.2f} floor for {part_number}; "
                            "repriced to floor before ERP push"
                        ),
                    }
                )
                return record
            record.update(
                {
                    "decision": DECISION_VETO,
                    "reason_code": REASON_BELOW_FLOOR,
                    "detail": (
                        f"quoted {quoted_price:.2f} is below the "
                        f"{price_floor:.2f} floor for {part_number} and "
                        "repricing is disabled; ERP push vetoed"
                    ),
                }
            )
            return record

        record["detail"] = (
            f"quoted {quoted_price:.2f} clears the {price_floor:.2f} floor "
            f"for {part_number}"
        )
        return record

    def evaluate_matches(
        self, matched_items: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Evaluate every catalog match and return per-line decisions."""
        return [
            self.evaluate_line_item(
                match.get("extracted_item"), match.get("catalog_item")
            )
            for match in (matched_items or [])
        ]


def apply_margin_decisions(
    extracted_data: Dict[str, Any],
    matched_items: List[Dict[str, Any]],
    report: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Apply repricing decisions to the extracted payload and match records.

    Line items and match records share index alignment (catalog_match_node
    builds matches 1:1 from line items, single-item payloads included), so
    decision[i] applies to line item i. When the payload carries the
    single-item mirror (top-level keys duplicating line item 0, the
    established ``extracted_data.update(line_items[0])`` convention), the
    mirror is refreshed too so the pushed payload stays consistent.
    Returns the mutated extracted_data.
    """
    line_items = extracted_data.get("line_items")
    has_line_item_list = isinstance(line_items, list) and bool(line_items)
    if not has_line_item_list:
        line_items = [extracted_data]

    repriced_indexes = []
    for index, decision in enumerate(report or []):
        if decision.get("decision") != DECISION_REPRICE:
            continue
        effective_price = decision.get("effective_price")
        if effective_price is None or index >= len(line_items):
            continue
        line_items[index]["unit_price"] = effective_price
        if (
            index < len(matched_items or [])
            and isinstance(matched_items[index].get("extracted_item"), dict)
        ):
            matched_items[index]["extracted_item"]["unit_price"] = effective_price
        repriced_indexes.append(index)

    if not has_line_item_list or 0 in repriced_indexes:
        extracted_data.update(line_items[0])
    return extracted_data


def build_price_delta_telemetry(
    extracted_data: Dict[str, Any],
    matched_items: List[Dict[str, Any]],
    report: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Per-line delta telemetry linking quoted, pushed, cost and floor prices.

    Consumes the margin-defender report when provided (repricing already
    applied); otherwise derives the pushed price directly from the line
    items. Only line items with a catalog match and a known cost produce
    entries — unmatched or cost-less lines carry no margin signal.
    """
    line_items = extracted_data.get("line_items")
    if not isinstance(line_items, list) or not line_items:
        line_items = [extracted_data]

    decisions = list(report or [])
    deltas: List[Dict[str, Any]] = []
    for index, match in enumerate(matched_items or []):
        catalog_item = match.get("catalog_item")
        if not isinstance(catalog_item, dict):
            continue
        if index >= len(line_items):
            continue
        unit_cost = _as_float(catalog_item.get("unit_cost"))
        if unit_cost is None or unit_cost <= 0:
            continue
        decision = decisions[index] if index < len(decisions) else {}
        extracted_item = match.get("extracted_item")
        if decision.get("quoted_price") is not None:
            quoted_price = _as_float(decision.get("quoted_price"))
        elif isinstance(extracted_item, dict):
            quoted_price = _as_float(extracted_item.get("unit_price"))
        else:
            quoted_price = None
        pushed_price = _as_float(line_items[index].get("unit_price"))
        price_floor = _as_float(catalog_item.get("price_floor"))
        if price_floor is None and decision.get("price_floor") is not None:
            price_floor = _as_float(decision.get("price_floor"))
        # ISO 4217 currency of THIS line (Layer 5): money math must never sum
        # across currencies. Resolution order honours the most specific
        # source first: reviewer decision > extracted line item > catalog.
        currency = (
            decision.get("currency")
            or (extracted_item or {}).get("currency")
            or catalog_item.get("currency")
        )
        currency = str(currency).upper()[:3] if isinstance(currency, str) else None
        deltas.append(
            {
                "line_index": index,
                "part_number": str(catalog_item.get("part_number", "")),
                "sku_id": str(catalog_item.get("sku_id", "")),
                "quantity": _as_positive_int(line_items[index].get("quantity")),
                "quoted_price": quoted_price,
                "pushed_price": pushed_price,
                "unit_cost": unit_cost,
                "price_floor": price_floor,
                "currency": currency,
                "margin_pct_at_push": _margin_pct(pushed_price, unit_cost),
                "repriced": bool(decision.get("repriced", False)),
                "reason_code": decision.get("reason_code"),
            }
        )
    return deltas


def _as_float(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _as_positive_int(value: Any, default: int = 1) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)) and int(value) > 0:
        return int(value)
    return default


def _margin_pct(price: Optional[float], cost: Optional[float]) -> Optional[float]:
    """Margin fraction of the sell price, None when not computable."""
    price_f = _as_float(price)
    cost_f = _as_float(cost)
    if price_f is None or cost_f is None or price_f <= 0:
        return None
    return round((price_f - cost_f) / price_f, 4)
