"""Unit-of-Measure (UoM) & Trade Canonicalizer for industrial B2B distribution.

Standardizes common industrial units across PVF, Electrical, HVAC, and Fluid Power
(e.g., EA, BX, FT, IN, MTR, C, M, RL, PKG) into canonical base units with exact multiplier
math so line items and quotes compare apples-to-apples without margin leakage.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
import re


class CanonicalUoM(StrEnum):
    """Canonical base units for trade comparisons."""

    EACH = "EA"
    FOOT = "FT"
    INCH = "IN"
    METER = "MTR"
    POUND = "LB"
    KILOGRAM = "KG"
    GALLON = "GAL"
    LITER = "LTR"


@dataclass(frozen=True, slots=True)
class NormalizedUoM:
    """Canonical representation of an industrial quantity and unit."""

    raw_unit: str
    canonical_unit: CanonicalUoM
    multiplier_to_canonical: Decimal
    normalized_quantity: Decimal
    normalized_unit_price: Decimal | None = None


# Trade abbreviations mapped to canonical unit and packaging factor.
UOM_SYNONYM_MAP: dict[str, tuple[CanonicalUoM, Decimal]] = {
    # Each / Count
    "ea": (CanonicalUoM.EACH, Decimal("1.0")),
    "each": (CanonicalUoM.EACH, Decimal("1.0")),
    "pc": (CanonicalUoM.EACH, Decimal("1.0")),
    "pcs": (CanonicalUoM.EACH, Decimal("1.0")),
    "piece": (CanonicalUoM.EACH, Decimal("1.0")),
    "pieces": (CanonicalUoM.EACH, Decimal("1.0")),
    "un": (CanonicalUoM.EACH, Decimal("1.0")),
    "unit": (CanonicalUoM.EACH, Decimal("1.0")),
    # Multi-unit packaging
    "pr": (CanonicalUoM.EACH, Decimal("2.0")),
    "pair": (CanonicalUoM.EACH, Decimal("2.0")),
    "dz": (CanonicalUoM.EACH, Decimal("12.0")),
    "doz": (CanonicalUoM.EACH, Decimal("12.0")),
    "dozen": (CanonicalUoM.EACH, Decimal("12.0")),
    "c": (CanonicalUoM.EACH, Decimal("100.0")),  # hundred in industrial catalog
    "hnd": (CanonicalUoM.EACH, Decimal("100.0")),
    "hundred": (CanonicalUoM.EACH, Decimal("100.0")),
    "m": (CanonicalUoM.EACH, Decimal("1000.0")),  # thousand (mille) in PVF/fasteners
    "th": (CanonicalUoM.EACH, Decimal("1000.0")),
    "thousand": (CanonicalUoM.EACH, Decimal("1000.0")),
    "bx": (CanonicalUoM.EACH, Decimal("1.0")),  # Container with package-level quantity
    "box": (CanonicalUoM.EACH, Decimal("1.0")),
    "pkg": (CanonicalUoM.EACH, Decimal("1.0")),
    "package": (CanonicalUoM.EACH, Decimal("1.0")),
    "pack": (CanonicalUoM.EACH, Decimal("1.0")),
    "ctn": (CanonicalUoM.EACH, Decimal("1.0")),
    "carton": (CanonicalUoM.EACH, Decimal("1.0")),
    "cs": (CanonicalUoM.EACH, Decimal("1.0")),
    "case": (CanonicalUoM.EACH, Decimal("1.0")),
    "skid": (CanonicalUoM.EACH, Decimal("1.0")),
    "plt": (CanonicalUoM.EACH, Decimal("1.0")),
    "pallet": (CanonicalUoM.EACH, Decimal("1.0")),
    # Linear / Length
    "ft": (CanonicalUoM.FOOT, Decimal("1.0")),
    "feet": (CanonicalUoM.FOOT, Decimal("1.0")),
    "foot": (CanonicalUoM.FOOT, Decimal("1.0")),
    "cft": (CanonicalUoM.FOOT, Decimal("100.0")),  # 100 feet
    "mft": (CanonicalUoM.FOOT, Decimal("1000.0")),  # 1000 feet
    "rl": (CanonicalUoM.FOOT, Decimal("1.0")),  # Reel / Roll length basis
    "reel": (CanonicalUoM.FOOT, Decimal("1.0")),
    "roll": (CanonicalUoM.FOOT, Decimal("1.0")),
    "in": (CanonicalUoM.INCH, Decimal("1.0")),
    "inch": (CanonicalUoM.INCH, Decimal("1.0")),
    "inches": (CanonicalUoM.INCH, Decimal("1.0")),
    "m": (CanonicalUoM.METER, Decimal("1.0")),
    "mtr": (CanonicalUoM.METER, Decimal("1.0")),
    "meter": (CanonicalUoM.METER, Decimal("1.0")),
    "meters": (CanonicalUoM.METER, Decimal("1.0")),
    "yd": (CanonicalUoM.FOOT, Decimal("3.0")),
    "yard": (CanonicalUoM.FOOT, Decimal("3.0")),
    # Weight
    "lb": (CanonicalUoM.POUND, Decimal("1.0")),
    "lbs": (CanonicalUoM.POUND, Decimal("1.0")),
    "pound": (CanonicalUoM.POUND, Decimal("1.0")),
    "cwt": (CanonicalUoM.POUND, Decimal("100.0")),  # Hundredweight
    "kg": (CanonicalUoM.KILOGRAM, Decimal("1.0")),
    "kgs": (CanonicalUoM.KILOGRAM, Decimal("1.0")),
    # Volume / Fluid Power
    "gal": (CanonicalUoM.GALLON, Decimal("1.0")),
    "gallon": (CanonicalUoM.GALLON, Decimal("1.0")),
    "l": (CanonicalUoM.LITER, Decimal("1.0")),
    "ltr": (CanonicalUoM.LITER, Decimal("1.0")),
    "liter": (CanonicalUoM.LITER, Decimal("1.0")),
}


def canonicalize_uom(
    raw_unit: str,
    quantity: Decimal | float | int | str,
    unit_price: Decimal | float | int | str | None = None,
    pack_size: int | Decimal = 1,
) -> NormalizedUoM:
    """Normalize a trade unit of measure and compute canonical quantity & unit price.

    Args:
        raw_unit: Raw UoM string from RFQ line item (e.g. 'C', 'BX', 'FT', 'M').
        quantity: Quoted quantity.
        unit_price: Optional unit price corresponding to raw_unit.
        pack_size: Packaging size if container unit (e.g., 50 pcs per box).
    """
    clean_unit = re.sub(r"[^a-zA-Z]", "", raw_unit).strip().lower()
    qty_dec = Decimal(str(quantity))
    price_dec = Decimal(str(unit_price)) if unit_price is not None else None
    pack_dec = Decimal(str(pack_size)) if pack_size > 0 else Decimal("1.0")

    if clean_unit in UOM_SYNONYM_MAP:
        canon_unit, factor = UOM_SYNONYM_MAP[clean_unit]
        # If packaging container like box/case, factor in pack_size
        if clean_unit in {"bx", "box", "pkg", "package", "pack", "ctn", "carton", "cs", "case"}:
            factor = factor * pack_dec
    else:
        # Default to EACH with 1.0 factor for unrecognised trade strings
        canon_unit = CanonicalUoM.EACH
        factor = Decimal("1.0")

    norm_qty = qty_dec * factor
    norm_price = (price_dec / factor) if (price_dec is not None and factor > 0) else None

    return NormalizedUoM(
        raw_unit=raw_unit,
        canonical_unit=canon_unit,
        multiplier_to_canonical=factor,
        normalized_quantity=norm_qty,
        normalized_unit_price=norm_price,
    )
