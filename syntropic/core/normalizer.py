"""Normalize procurement units and dimensional trade attributes."""

import re
from typing import Any

UOM_DICTIONARY = {
    "EA": ["EA", "EACH", "PC", "PCS", "PIECE", "PIECES", "UNIT", "UNT"],
    "BX": ["BX", "BOX", "BOXES", "PK", "PACK", "PACKS", "PKG", "PACKAGE"],
    "FT": ["FT", "FEET", "FOOT", "'"],
    "IN": ["IN", "INCH", "INCHES", '"'],
    "MTR": ["M", "MTR", "METER", "METERS", "METRE", "METRES"],
    "LBS": ["LB", "LBS", "POUND", "POUNDS"],
    "KG": ["KG", "KGS", "KILOGRAM", "KILOGRAMS"],
}

REVERSE_UOM_LOOKUP = {
    alias: canonical
    for canonical, aliases in UOM_DICTIONARY.items()
    for alias in aliases
}

_DIMENSION_PATTERN = re.compile(
    r"(?<![\w./-])"
    r"(?P<value>\d+\s*/\s*\d+|\d+(?:\.\d+)?)\s*"
    r"(?P<unit>millimeters?|millimetres?|mm|inches?|inch|in|\"|')"
    r"(?![a-z])",
    re.IGNORECASE,
)
_BARE_DIMENSION_PATTERN = re.compile(
    r"^\s*(?P<value>\d+\.\d+)\s*$"
)
_LABELED_BARE_DIMENSION_PATTERN = re.compile(
    r"\b(?:size|diameter|width|height|thickness)\s*[:=]?\s*"
    r"(?P<value>\d+\.\d+)\b",
    re.IGNORECASE,
)
_PACK_PATTERN = re.compile(r"^(?:a\s+)?pack\s+of\s+\d+$", re.IGNORECASE)


def _parse_number(value: str) -> float | None:
    if "/" not in value:
        return float(value)
    numerator, denominator = value.split("/", maxsplit=1)
    divisor = float(denominator)
    if divisor == 0:
        return None
    return float(numerator) / divisor


def _format_number(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".")


def _canonical_uom(raw_uom: str | None) -> str | None:
    if not raw_uom or not raw_uom.strip():
        return "EA"
    cleaned = raw_uom.strip().upper().replace(".", "")
    if _PACK_PATTERN.fullmatch(cleaned):
        return "BX"
    return REVERSE_UOM_LOOKUP.get(cleaned)


class TradeAttributeNormalizer:
    """Standardize trade UoM codes and common dimensional descriptions."""

    @classmethod
    def normalize_uom(cls, raw_uom: str) -> str:
        """Convert a recognized unit to its ERP code; default unknown units to EA."""
        return _canonical_uom(raw_uom) or "EA"

    @classmethod
    def extract_dimensions(cls, description: str) -> tuple[str, dict[str, Any]]:
        """Normalize inch/mm dimensions while retaining their source measurements."""
        specs: dict[str, Any] = {}

        def replace_dimension(match: re.Match[str]) -> str:
            value = _parse_number(match.group("value"))
            if value is None:
                return match.group(0)
            unit = match.group("unit").lower()
            if unit in {"mm", "millimeter", "millimeters", "millimetre", "millimetres"}:
                specs.setdefault("size_mm", value)
                inches = value / 25.4
            elif unit == "'":
                specs.setdefault("size_ft", value)
                inches = value * 12
            else:
                inches = value
            specs.setdefault("size_in", inches)
            return f"{_format_number(inches)} IN"

        normalized = _DIMENSION_PATTERN.sub(replace_dimension, description)
        bare_match = _BARE_DIMENSION_PATTERN.fullmatch(normalized)
        if bare_match:
            value = float(bare_match.group("value"))
            specs.setdefault("size_in", value)
            normalized = f"{_format_number(value)} IN"
        else:
            def replace_labeled_dimension(match: re.Match[str]) -> str:
                value = float(match.group("value"))
                specs.setdefault("size_in", value)
                return f"{_format_number(value)} IN"

            normalized = _LABELED_BARE_DIMENSION_PATTERN.sub(
                replace_labeled_dimension, normalized
            )

        return " ".join(normalized.strip().upper().split()), specs


def normalize_uom_if_supported(raw_uom: str | None) -> str | None:
    """Return a canonical UoM or None when a non-empty value is unsupported."""
    return _canonical_uom(raw_uom)
