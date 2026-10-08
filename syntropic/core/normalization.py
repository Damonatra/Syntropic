"""Deterministic normalization for extracted RFQ line-item attributes."""

import re
from typing import Any

from syntropic.core.normalizer import normalize_uom_if_supported

_UOM_ALIASES = {
    "ea": "EA",
    "each": "EA",
    "pc": "EA",
    "pcs": "EA",
    "piece": "EA",
    "pieces": "EA",
    "unit": "EA",
    "units": "EA",
    "m": "MTR",
    "meter": "MTR",
    "meters": "MTR",
    "metre": "MTR",
    "metres": "MTR",
    "mtr": "MTR",
    "ft": "FT",
    "foot": "FT",
    "feet": "FT",
    "kg": "KG",
    "kilogram": "KG",
    "kilograms": "KG",
    "lb": "LBS",
    "lbs": "LBS",
    "pound": "LBS",
    "pounds": "LBS",
    "l": "L",
    "liter": "L",
    "liters": "L",
    "litre": "L",
    "litres": "L",
    "gal": "GAL",
    "gallon": "GAL",
    "gallons": "GAL",
}


def normalize_unit_of_measure(value: str | None) -> str | None:
    """Normalize supported aliases without converting between physical units."""
    if value is None or not value.strip():
        return "EA"
    canonical_uom = normalize_uom_if_supported(value)
    if canonical_uom is not None:
        return canonical_uom
    key = re.sub(r"[\s._-]+", "", value).lower()
    return _UOM_ALIASES.get(key)


def normalize_extracted_data(
    extracted_data: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    normalized = dict(extracted_data)
    source_items = extracted_data.get("line_items") or [extracted_data]
    normalized_items: list[dict[str, Any]] = []
    errors: list[str] = []

    for index, source_item in enumerate(source_items):
        item = dict(source_item)
        part_number = str(item.get("part_number", "")).strip().upper()
        if part_number:
            item["part_number"] = part_number
        unit = item.get("unit_of_measure")
        normalized_unit = normalize_unit_of_measure(
            unit if isinstance(unit, str) else None
        )
        if normalized_unit is None:
            errors.append(
                f"line_items.{index}.unit_of_measure: unsupported unit {unit!r}"
            )
        else:
            item["unit_of_measure"] = normalized_unit
        normalized_items.append(item)

    normalized["line_items"] = normalized_items
    if normalized_items:
        normalized.update(normalized_items[0])
    return normalized, errors
