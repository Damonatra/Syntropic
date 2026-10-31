"""Firmographic normalisation: vertical classification, region detection and
the $10M–$150M revenue corridor filter that gates the Syntropic Q4 pipeline.

All functions are pure and synchronous so they are trivially testable and can
run inside scraper coroutines without contention.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from vertebra.config.settings import REVENUE_CEILING_USD, REVENUE_FLOOR_USD
from vertebra.ingestion.uom_normalizer import CanonicalUoM, NormalizedUoM, canonicalize_uom
from vertebra.models.domain import CompanyRecord, Region, Vertical

# --------------------------------------------------------------------------- #
# Vertical classification
# --------------------------------------------------------------------------- #

_VERTICAL_KEYWORDS: dict[Vertical, tuple[str, ...]] = {
    Vertical.PVF: (
        "pipe", "valve", "fitting", "pvf", "flange", "pipe distributor",
        "industrial piping", "tube & pipe", "plumbing wholesale",
    ),
    Vertical.ELECTRICAL: (
        "electrical", "electric supply", "electric distributor", "wire & cable",
        "switchgear", "lighting distributor", "industrial electric", "conduit",
    ),
    Vertical.HVAC: (
        "hvac", "heating", "ventilation", "air conditioning", "refrigeration",
        "hydronics", "boiler", "furnace distributor", "ductwork",
    ),
    Vertical.FLUID_POWER: (
        "fluid power", "hydraulic", "pneumatic", "motion control", "seals & o-rings",
        "bearings & power transmission", "hydraulics", "pneumatics", "compressor",
    ),
}

_VERTICAL_PRIORITY: tuple[Vertical, ...] = (
    Vertical.PVF,
    Vertical.FLUID_POWER,
    Vertical.HVAC,
    Vertical.ELECTRICAL,
)


def classify_vertical(*texts: str | None) -> Vertical | None:
    """Classify the dominant target vertical from concatenated free text.

    Scans in priority order (PVF first) so composite descriptions like
    "PVF & electrical supply" resolve to the more specific PVF vertical.
    """
    blob = " ".join(t for t in texts if t).lower()
    if not blob.strip():
        return None
    for vertical in _VERTICAL_PRIORITY:
        for keyword in _VERTICAL_KEYWORDS[vertical]:
            if keyword in blob:
                return vertical
    return None


# --------------------------------------------------------------------------- #
# Region detection (US / Canada) — drives CASL enforcement downstream
# --------------------------------------------------------------------------- #

_CA_PROVINCES: frozenset[str] = frozenset(
    {"alberta", "british columbia", "manitoba", "new brunswick", "newfoundland and labrador",
     "newfoundland", "nova scotia", "ontario", "prince edward island", "quebec",
     "saskatchewan", "northwest territories", "nunavut", "yukon"}
)

_CA_PROVINCE_CODES: frozenset[str] = frozenset(
    {"ab", "bc", "mb", "nb", "nl", "ns", "nt", "nu", "on", "pe", "qc", "sk", "yt"}
)

_US_STATE_CODES: frozenset[str] = frozenset(
    {"al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in",
     "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv",
     "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn",
     "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc"}
)

_US_STATE_NAMES: frozenset[str] = frozenset(
    {"alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
     "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
     "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
     "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
     "new hampshire", "new jersey", "new mexico", "new york", "north carolina",
     "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island",
     "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
     "virginia", "washington", "west virginia", "wisconsin", "wyoming",
     "district of columbia"}
)

_CA_POSTAL_RE = re.compile(r"\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b", re.I)


def detect_region(
    *,
    state_province: str | None = None,
    country: str | None = None,
    postal_code: str | None = None,
    domain: str | None = None,
) -> Region | None:
    """Infer the serving region from any combination of address signals."""
    prov = (state_province or "").strip().lower()
    country_norm = (country or "").strip().lower()

    if country_norm in {"canada", "ca", "can"} or prov in _CA_PROVINCES or prov in _CA_PROVINCE_CODES:
        return Region.CA
    if (
        country_norm in {"usa", "us", "united states", "united states of america"}
        or prov in _US_STATE_CODES
        or prov in _US_STATE_NAMES
    ):
        return Region.US
    if postal_code and _CA_POSTAL_RE.search(postal_code):
        return Region.CA
    if domain and domain.lower().endswith(".ca"):
        return Region.CA
    return None


def is_canadian_domain(domain: str | None) -> bool:
    """True for .ca ccTLD domains — a strong CASL jurisdiction signal."""
    return bool(domain) and domain.lower().endswith(".ca")  # type: ignore[union-attr]


# --------------------------------------------------------------------------- #
# Revenue corridor ($10M–$150M)
# --------------------------------------------------------------------------- #

# Revenue-per-employee bands (USD) used when directories expose headcount but
# not revenue. Ranges reflect published industry averages for distribution.
_REV_PER_EMPLOYEE: dict[Vertical | None, tuple[int, int]] = {
    Vertical.PVF: (450_000, 1_100_000),
    Vertical.ELECTRICAL: (550_000, 1_300_000),
    Vertical.HVAC: (400_000, 950_000),
    Vertical.FLUID_POWER: (400_000, 1_000_000),
    None: (400_000, 1_200_000),
}


def estimate_revenue(
    employee_count: int | None, vertical: Vertical | None
) -> tuple[int, str] | None:
    """Return ``(revenue_estimate_usd, confidence)`` from headcount, if possible."""
    if employee_count is None or employee_count < 1:
        return None
    low_per, high_per = _REV_PER_EMPLOYEE.get(vertical, _REV_PER_EMPLOYEE[None])
    low = employee_count * low_per
    high = employee_count * high_per
    midpoint = (low + high) // 2
    # Confidence degrades with distance from the corridor midpoint.
    return midpoint, "estimated"


def corridor_check(record: CompanyRecord) -> tuple[bool, str | None]:
    """Gate a record against the $10M–$150M corridor and target verticals.

    Returns ``(accepted, rejection_reason)``. Reason is ``None`` when accepted.
    """
    if record.vertical is None:
        return False, "vertical_unmatched"

    revenue = record.revenue_estimate_usd
    if revenue is None and record.employee_count is not None:
        estimate = estimate_revenue(record.employee_count, record.vertical)
        if estimate:
            revenue, _ = estimate

    if revenue is None:
        return False, "revenue_unknown"

    if revenue < REVENUE_FLOOR_USD:
        return False, f"revenue_below_floor ({revenue:,} < {REVENUE_FLOOR_USD:,})"
    if revenue > REVENUE_CEILING_USD:
        return False, f"revenue_above_ceiling ({revenue:,} > {REVENUE_CEILING_USD:,})"
    return True, None


# --------------------------------------------------------------------------- #
# Domain helpers
# --------------------------------------------------------------------------- #

_MULTITLD_SUFFIXES = (
    "co.uk", "org.uk", "com.au", "co.nz", "com.mx", "on.ca", "qc.ca", "gc.ca",
)


def registrable_domain(url_or_domain: str) -> str | None:
    """Extract the registrable domain (host with scheme/path stripped)."""
    raw = (url_or_domain or "").strip().lower()
    if not raw:
        return None
    if "://" in raw:
        raw = urlparse(raw).netloc or raw
    raw = raw.split("/")[0].split("?")[0].split(":")[0].strip(".@")
    if not raw or "." not in raw:
        return None
    # Keep one trailing label pair (or known multi-part suffix).
    parts = raw.split(".")
    suffix_len = 2
    for suffix in _MULTITLD_SUFFIXES:
        if raw.endswith("." + suffix):
            suffix_len = suffix.count(".") + 1
            break
    if len(parts) <= suffix_len:
        return raw
    return ".".join(parts[-(suffix_len + 1):])


def normalise_name(name: str) -> str:
    """Normalise a company display name for dedup keys."""
    cleaned = re.sub(r"\s+", " ", name).strip()
    for drop in (" inc.", " inc", " llc", " ltd.", " ltd", " corp.", " corp",
                 " co.", " co", " company", " ltd,", " ,"):
        if cleaned.lower().endswith(drop):
            cleaned = cleaned[: -len(drop)].rstrip(" ,.")
    return cleaned


# --------------------------------------------------------------------------- #
# Line Item UoM standardization
# --------------------------------------------------------------------------- #


def standardize_line_item(
    raw_unit: str,
    quantity: int | float | str,
    unit_price: int | float | str | None = None,
    pack_size: int = 1,
) -> NormalizedUoM:
    """Standardize line item quantities and units of measure into canonical units."""
    return canonicalize_uom(
        raw_unit=raw_unit,
        quantity=quantity,
        unit_price=unit_price,
        pack_size=pack_size,
    )
