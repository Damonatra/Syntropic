"""SPA rebate and cost-sheet interception for catalog-matched line items.

The interceptor performs margin-leakage checks against the matched catalog
entry's SPA (special pricing agreement) rebate schedule, volume tiers, and
cost-sheet freshness. It never mutates prices; it surfaces structured flags
that the workflow records as margin telemetry.
"""

from datetime import date, datetime
from typing import Any, Dict, List, Optional

REASON_UNAPPLIED_REBATE = "UNAPPLIED_REBATE"
REASON_VOLUME_TIER_AVAILABLE = "VOLUME_TIER_AVAILABLE"
REASON_COST_SHEET_LAG = "COST_SHEET_LAG"
REASON_MALFORMED_SCHEDULE = "MALFORMED_SCHEDULE"

REASON_CODES = (
    REASON_UNAPPLIED_REBATE,
    REASON_VOLUME_TIER_AVAILABLE,
    REASON_COST_SHEET_LAG,
    REASON_MALFORMED_SCHEDULE,
)

DEFAULT_COST_SHEET_MAX_AGE_DAYS = 90


class SPARebateInterceptor:
    """Detects rebate and cost-sheet discrepancies on a matched line item."""

    def __init__(
        self,
        today: Optional[date] = None,
        cost_sheet_max_age_days: int = DEFAULT_COST_SHEET_MAX_AGE_DAYS,
    ) -> None:
        self.today = today or date.today()
        self.cost_sheet_max_age_days = cost_sheet_max_age_days

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def intercept_line_item(
        self,
        extracted_item: Optional[Dict[str, Any]],
        catalog_item: Optional[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Return every rebate flag that fires for one matched line item."""
        flags: List[Dict[str, Any]] = []
        if not isinstance(catalog_item, dict) or not catalog_item:
            return flags
        if not isinstance(extracted_item, dict):
            extracted_item = {}

        part_number = str(catalog_item.get("part_number", "") or "")
        sku_id = str(catalog_item.get("sku_id", "") or "")
        quantity = self._as_positive_int(extracted_item.get("quantity"), default=1)
        quoted_price = self._as_float(extracted_item.get("unit_price"))
        list_price = self._as_float(catalog_item.get("unit_price"))
        schedule = catalog_item.get("rebate_schedule")

        if not isinstance(schedule, dict):
            schedule = None

        if schedule is not None and not self.schedule_is_well_formed(schedule):
            flags.append(
                self._flag(
                    REASON_MALFORMED_SCHEDULE,
                    sku_id,
                    part_number,
                    "rebate schedule is missing a rebate rate or has an "
                    "inverted effective window",
                )
            )

        if schedule is not None:
            flat_rate = self._as_float(schedule.get("rebate_pct"))
            active = self.rebate_is_active(schedule, self.today)

            if active and flat_rate is not None:
                flags.extend(
                    self._unapplied_rebate_flags(
                        sku_id, part_number, quoted_price, list_price, flat_rate
                    )
                )
                tier = self.best_volume_tier(schedule, quantity)
                if tier is not None and tier["rebate_pct"] > flat_rate:
                    flags.append(
                        self._flag(
                            REASON_VOLUME_TIER_AVAILABLE,
                            sku_id,
                            part_number,
                            f"quantity {quantity} qualifies for a "
                            f"{tier['rebate_pct']:.0%} volume-tier rebate "
                            f"deeper than the {flat_rate:.0%} flat rate",
                        )
                    )

        stale_cost_sheet = self.cost_sheet_is_stale(
            catalog_item.get("cost_sheet_updated"), self.today
        )
        if stale_cost_sheet:
            updated = catalog_item.get("cost_sheet_updated")
            flags.append(
                self._flag(
                    REASON_COST_SHEET_LAG,
                    sku_id,
                    part_number,
                    f"cost sheet last updated {updated}, older than "
                    f"{self.cost_sheet_max_age_days} days",
                )
            )
        return flags

    # ------------------------------------------------------------------
    # Schedule helpers
    # ------------------------------------------------------------------

    @staticmethod
    def schedule_is_well_formed(schedule: Dict[str, Any]) -> bool:
        """A schedule is well formed when it carries a usable rebate rate."""
        if not isinstance(schedule, dict):
            return False
        has_flat_rate = isinstance(schedule.get("rebate_pct"), (int, float)) and (
            0.0 <= float(schedule["rebate_pct"]) <= 1.0
        )
        tiers = schedule.get("volume_tiers") or []
        has_valid_tiers = isinstance(tiers, list) and all(
            isinstance(tier, dict)
            and isinstance(tier.get("min_qty"), (int, float))
            and isinstance(tier.get("rebate_pct"), (int, float))
            for tier in tiers
        )
        if not (has_flat_rate or has_valid_tiers):
            return False
        effective_from = _parse_date(schedule.get("effective_from"))
        effective_until = _parse_date(schedule.get("effective_until"))
        if effective_from and effective_until and effective_from > effective_until:
            return False
        return True

    @staticmethod
    def rebate_is_active(schedule: Dict[str, Any], today: date) -> bool:
        effective_from = _parse_date(schedule.get("effective_from"))
        effective_until = _parse_date(schedule.get("effective_until"))
        if effective_from and today < effective_from:
            return False
        if effective_until and today > effective_until:
            return False
        return True

    @staticmethod
    def best_volume_tier(
        schedule: Dict[str, Any], quantity: int
    ) -> Optional[Dict[str, Any]]:
        """Deepest tier whose minimum quantity is satisfied, if any."""
        tiers = schedule.get("volume_tiers") or []
        qualifying = [
            {
                "min_qty": int(tier["min_qty"]),
                "rebate_pct": float(tier["rebate_pct"]),
            }
            for tier in tiers
            if isinstance(tier, dict)
            and isinstance(tier.get("min_qty"), (int, float))
            and isinstance(tier.get("rebate_pct"), (int, float))
            and quantity >= int(tier["min_qty"])
        ]
        if not qualifying:
            return None
        return max(qualifying, key=lambda tier: tier["rebate_pct"])

    @staticmethod
    def cost_sheet_is_stale(
        cost_sheet_updated: Any, today: date, max_age_days: int = 90
    ) -> bool:
        updated = _parse_date(cost_sheet_updated)
        if updated is None:
            return False
        return (today - updated).days > max_age_days

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _unapplied_rebate_flags(
        self,
        sku_id: str,
        part_number: str,
        quoted_price: Optional[float],
        list_price: Optional[float],
        flat_rate: float,
    ) -> List[Dict[str, Any]]:
        if quoted_price is None:
            return [
                self._flag(
                    REASON_UNAPPLIED_REBATE,
                    sku_id,
                    part_number,
                    f"active {flat_rate:.0%} SPA rebate present but the "
                    "line item carries no quoted price confirming it was "
                    "applied",
                )
            ]
        if list_price is None:
            return []
        expected_net = list_price * (1.0 - flat_rate)
        if quoted_price > expected_net + 0.005:
            return [
                self._flag(
                    REASON_UNAPPLIED_REBATE,
                    sku_id,
                    part_number,
                    f"quoted price {quoted_price:.2f} exceeds the "
                    f"rebated price {expected_net:.2f} "
                    f"(list {list_price:.2f} minus {flat_rate:.0%})",
                )
            ]
        return []

    @staticmethod
    def _as_float(value: Any) -> Optional[float]:
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return float(value)
        return None

    @staticmethod
    def _as_positive_int(value: Any, default: int = 1) -> int:
        if isinstance(value, bool):
            return default
        if isinstance(value, (int, float)) and int(value) > 0:
            return int(value)
        return default

    @staticmethod
    def _flag(reason_code: str, sku_id: str, part_number: str, detail: str) -> Dict[str, Any]:
        return {
            "reason_code": reason_code,
            "sku_id": sku_id,
            "catalog_part_number": part_number,
            "detail": detail,
        }


def _parse_date(value: Any) -> Optional[date]:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return date.fromisoformat(value.strip()[:10])
        except ValueError:
            return None
    return None
