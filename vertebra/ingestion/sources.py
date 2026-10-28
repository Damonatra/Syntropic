"""Directory source adapters and the US/CA source registry.

Each adapter turns raw directory payloads into structured dicts. Adapters are
deliberately resilient: industrial directories (The Blue Book, ThomasNet,
NFPA/IFPS member rosters, Canadian association member lists) share common
shapes — schema.org JSON-LD blocks, card-style HTML listings, or CSV feeds —
and these adapters cover all three without hard-coding any single site's
private CSS classes.
"""

from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from vertebra.models.domain import Region, Vertical

# --------------------------------------------------------------------------- #
# Adapter protocol
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class ParsedListing:
    """One raw listing extracted from a directory source."""

    name: str
    website: str | None = None
    domain_hint: str | None = None
    address_text: str | None = None
    city: str | None = None
    state_province: str | None = None
    country: str | None = None
    postal_code: str | None = None
    employee_count: int | None = None
    revenue_text: str | None = None
    description: str | None = None
    erp_hint: str | None = None


class SourceAdapter(Protocol):
    """Contract every directory adapter fulfils."""

    id: str
    vertical_hint: Vertical | None
    region_hint: Region | None

    def parse(self, body: str, content_type: str) -> list[ParsedListing]: ...


# --------------------------------------------------------------------------- #
# Shared extraction helpers
# --------------------------------------------------------------------------- #

_EMPLOYEE_RE = re.compile(r"(\d[\d,]*)\s*(?:employees|associates|people|staff)", re.I)
_REVENUE_RANGE_RE = re.compile(
    r"\$\s?([\d.]+)\s?([mb])\b\s?[-–—to]+\s?\$?\s?([\d.]+)\s?([mb])\b", re.I
)
_REVENUE_SINGLE_RE = re.compile(r"\$\s?([\d.]+)\s?([mb])\b", re.I)
_CITY_STATE_RE = re.compile(
    r"([A-Za-z .'.-]+),\s*([A-Z]{2}|[A-Za-z]{2,})\s+(\d{5}(?:-\d{4})?|[A-Z]\d[A-Z]\s?\d[A-Z]\d)?"
)
_ERP_SIGNATURES: tuple[str, ...] = (
    "Epicor", "Eclipse", "Infor", "NetSuite", "SAP", "Oracle", "Syspro", "S2K",
    "Vai S2K", "Prophet 21", "P21", "Acumatica", "Distribution One", "Kerridge",
    "Odoo", "Microsoft Dynamics", "Dynamics 365", "QuickBooks", "Sage",
    "Portal", "Customer Portal", "B2B Portal", "EDI",
)


def extract_employee_count(text: str) -> int | None:
    match = _EMPLOYEE_RE.search(text or "")
    if not match:
        return None
    try:
        return int(match.group(1).replace(",", ""))
    except ValueError:
        return None


def extract_revenue_usd(text: str | None) -> tuple[int, str] | None:
    """Parse revenue text like ``$10M - $50M`` into ``(usd, confidence)``."""
    if not text:
        return None
    multi = _REVENUE_RANGE_RE.search(text)
    if multi:
        low = float(multi.group(1)) * {"m": 1e6, "b": 1e9}[multi.group(2).lower()]
        high = float(multi.group(3)) * {"m": 1e6, "b": 1e9}[multi.group(4).lower()]
        return int((low + high) / 2), "banded"
    single = _REVENUE_SINGLE_RE.search(text)
    if single:
        value = float(single.group(1)) * {"m": 1e6, "b": 1e9}[single.group(2).lower()]
        return int(value), "estimated"
    return None


def extract_erp_signature(text: str | None) -> str | None:
    if not text:
        return None
    lowered = text.lower()
    for signature in _ERP_SIGNATURES:
        if signature.lower() in lowered:
            return signature
    return None


def split_address(text: str | None) -> tuple[str | None, str | None, str | None]:
    """Best-effort ``(city, state_province, postal_code)`` from an address blob."""
    if not text:
        return None, None, None
    match = _CITY_STATE_RE.search(text)
    if not match:
        return None, None, None
    city = match.group(1).strip(" .,-") or None
    state = match.group(2).strip() or None
    postal = (match.group(3) or "").strip() or None
    return city, state, postal


# --------------------------------------------------------------------------- #
# Concrete adapters
# --------------------------------------------------------------------------- #


class JsonLdListingAdapter:
    """Parses schema.org JSON-LD blocks (ItemList / LocalBusiness / Organization).

    Many modern directory front-ends (and association member finders) embed
    structured data; this adapter is the highest-fidelity parser available
    without a site-specific contract.
    """

    def __init__(self, source_id: str, vertical_hint: Vertical | None, region_hint: Region | None) -> None:
        self.id = source_id
        self.vertical_hint = vertical_hint
        self.region_hint = region_hint

    def parse(self, body: str, content_type: str) -> list[ParsedListing]:
        listings: list[ParsedListing] = []
        for blob in _iter_jsonld_blobs(body):
            listings.extend(_parse_jsonld_node(blob))
        return listings


class GenericHTMLListingAdapter:
    """Heuristic parser for card-style HTML directory listings.

    Extracts anchor+heading pairs and surrounding text blocks; robust to the
    div/class churn that breaks brittle per-site scrapers.
    """

    def __init__(self, source_id: str, vertical_hint: Vertical | None, region_hint: Region | None) -> None:
        self.id = source_id
        self.vertical_hint = vertical_hint
        self.region_hint = region_hint

    def parse(self, body: str, content_type: str) -> list[ParsedListing]:
        try:
            from selectolax.parser import HTMLParser  # local import: optional at import time
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("selectolax is required for HTML adapters: pip install selectolax") from exc

        tree = HTMLParser(body)
        listings: list[ParsedListing] = []
        seen_names: set[str] = set()

        # Cards are any element that carries a heading and an external link.
        for node in tree.css("article, li, div[class*=card], div[class*=listing], div[class*=result]"):
            heading = node.css_first("h1,h2,h3,h4")
            if heading is None:
                continue
            name = heading.text(separator=" ", strip=True)
            name = re.sub(r"\s+", " ", name)
            if not (2 <= len(name) <= 200) or name.lower() in seen_names:
                continue
            link = node.css_first("a[href]")
            href = link.attributes.get("href") if link else None
            block_text = node.text(separator=" ", strip=True)
            if len(block_text) > 4000:
                block_text = block_text[:4000]
            city, state, postal = split_address(block_text)
            employee_count = extract_employee_count(block_text)
            revenue = extract_revenue_usd(block_text)
            listing = ParsedListing(
                name=name,
                website=href,
                address_text=block_text[:500],
                city=city,
                state_province=state,
                postal_code=postal,
                employee_count=employee_count,
                revenue_text=None if revenue is None else f"{revenue[0]}",
                description=block_text[:1000],
                erp_hint=extract_erp_signature(block_text),
            )
            seen_names.add(name.lower())
            listings.append(listing)
        return listings


class CSVFeedAdapter:
    """Parses CSV member-list feeds that associations commonly publish."""

    _FIELD_ALIASES: dict[str, tuple[str, ...]] = {
        "name": ("company", "company name", "company_name", "member", "organization", "org"),
        "website": ("website", "url", "web", "site", "homepage"),
        "city": ("city", "town"),
        "state_province": ("state", "province", "state/province", "region"),
        "country": ("country",),
        "postal_code": ("postal", "postal code", "zip", "zip code"),
        "employee_count": ("employees", "employee count", "headcount"),
        "description": ("description", "about", "profile", "notes"),
    }

    def __init__(self, source_id: str, vertical_hint: Vertical | None, region_hint: Region | None) -> None:
        self.id = source_id
        self.vertical_hint = vertical_hint
        self.region_hint = region_hint

    def parse(self, body: str, content_type: str) -> list[ParsedListing]:
        reader = csv.DictReader(io.StringIO(body))
        rows: list[ParsedListing] = []
        for raw in reader:
            lowered = {k.strip().lower(): (v or "").strip() for k, v in raw.items() if k}
            picked: dict[str, str] = {}
            for canonical, aliases in self._FIELD_ALIASES.items():
                for alias in aliases:
                    if lowered.get(alias):
                        picked[canonical] = lowered[alias]
                        break
            if not picked.get("name"):
                continue
            employee_count = None
            if picked.get("employee_count"):
                digits = re.sub(r"[^\d]", "", picked["employee_count"])
                employee_count = int(digits) if digits else None
            city, state, postal = split_address(picked.get("state_province", ""))
            rows.append(
                ParsedListing(
                    name=picked["name"],
                    website=picked.get("website") or None,
                    city=picked.get("city") or city,
                    state_province=picked.get("state_province") or state,
                    country=picked.get("country") or None,
                    postal_code=picked.get("postal_code") or postal,
                    employee_count=employee_count,
                    description=picked.get("description"),
                    erp_hint=extract_erp_signature(picked.get("description", "")),
                )
            )
        return rows


def _iter_jsonld_blobs(body: str) -> list[dict[str, Any]]:
    blobs: list[dict[str, Any]] = []
    for match in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', body, re.S | re.I
    ):
        raw = match.group(1).strip()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        candidates = data if isinstance(data, list) else [data]
        for candidate in candidates:
            if isinstance(candidate, dict):
                blobs.append(candidate)
                for nested in candidate.get("@graph", []) or []:
                    if isinstance(nested, dict):
                        blobs.append(nested)
    return blobs


def _parse_jsonld_node(node: dict[str, Any]) -> list[ParsedListing]:
    type_ = node.get("@type", "")
    types = set(type_ if isinstance(type_, list) else [type_])
    interesting = {"ItemList", "LocalBusiness", "Organization", "Corporation", "Store"}
    if not types & interesting:
        return []

    if "ItemList" in types:
        listings: list[ParsedListing] = []
        for item in node.get("itemListElement", []) or []:
            if isinstance(item, dict):
                target = item.get("item", item)
                if isinstance(target, dict):
                    listings.extend(_parse_jsonld_node(target))
        return listings

    name = str(node.get("name") or "").strip()
    if not name:
        return []
    address = node.get("address") or {}
    if isinstance(address, list):
        address = address[0] if address else {}
    address_text = " ".join(
        str(address.get(k) or "") for k in ("streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry")
    ).strip() or None
    city, state, postal = split_address(address_text)
    revenue = extract_revenue_usd(json.dumps(node))
    return [
        ParsedListing(
            name=name,
            website=node.get("url"),
            domain_hint=node.get("url"),
            address_text=address_text,
            city=address.get("addressLocality") or city,
            state_province=address.get("addressRegion") or state,
            country=address.get("addressCountry"),
            postal_code=address.get("postalCode") or postal,
            employee_count=extract_employee_count(node.get("description") or "") or _employees_from_jsonld(node),
            revenue_text=None if revenue is None else str(revenue[0]),
            description=node.get("description"),
            erp_hint=extract_erp_signature(json.dumps(node)[:4000]),
        )
    ]


def _employees_from_jsonld(node: dict[str, Any]) -> int | None:
    value = node.get("numberOfEmployees")
    if isinstance(value, dict):
        value = value.get("value")
    if isinstance(value, str):
        digits = re.sub(r"[^\d]", "", value)
        return int(digits) if digits else None
    if isinstance(value, int):
        return value
    return None


# --------------------------------------------------------------------------- #
# Source registry — real US & CA industrial directories
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class SourceSeed:
    """A configured crawl target: an adapter plus its listing URLs."""

    adapter: SourceAdapter
    urls: list[str]
    notes: str = ""


@dataclass(slots=True)
class SourceRegistry:
    """Registry of crawl targets; extended via ``register`` or config file."""

    seeds: dict[str, SourceSeed] = field(default_factory=dict)

    def register(self, seed: SourceSeed) -> None:
        self.seeds[seed.adapter.id] = seed

    def ids(self) -> list[str]:
        return sorted(self.seeds)

    def get(self, source_id: str) -> SourceSeed:
        return self.seeds[source_id]


def default_registry() -> SourceRegistry:
    """Registry pre-loaded with the Q4 target directories.

    URLs point at public listing/section roots. The adapters parse whatever
    listing payloads those pages serve; operators may append deep category
    URLs (e.g. ``?term=pipe+valves``) via ``SourceSeed.urls`` at deploy time.
    """
    registry = SourceRegistry()

    # -- The Blue Book: premier US/CA construction & industrial specifiers.
    registry.register(
        SourceSeed(
            adapter=GenericHTMLListingAdapter("blue_book", None, None),
            urls=[
                "https://www.thebluebook.com/search?searchSrc=NAV&what=pipe%20valves%20fittings&where=United%20States",
                "https://www.thebluebook.com/search?searchSrc=NAV&what=electrical%20supplies&where=United%20States",
                "https://www.thebluebook.com/search?searchSrc=NAV&what=hvac%20supplies&where=United%20States",
            ],
            notes="Card-style HTML listings; national US coverage.",
        )
    )

    # -- NFPA / fluid power distributor & manufacturer directory.
    registry.register(
        SourceSeed(
            adapter=JsonLdListingAdapter("nfpa_fluid_power", Vertical.FLUID_POWER, None),
            urls=["https://www.nfpa.com/membership/member-directory"],
            notes="Fluid Power member directory (US + CA chapters).",
        )
    )

    # -- NAED: National Association of Electrical Distributors members.
    registry.register(
        SourceSeed(
            adapter=CSVFeedAdapter("naed_members", Vertical.ELECTRICAL, None),
            urls=["https://www.naed.org/members/member-directory"],
            notes="Electrical distributor association roster.",
        )
    )

    # -- CIPH: Canadian Institute of Plumbing & Heating member directory.
    registry.register(
        SourceSeed(
            adapter=GenericHTMLListingAdapter("ciph_members", Vertical.PVF, Region.CA),
            urls=["https://ciph.com/directories/member-directory"],
            notes="Canadian PVF + HVAC wholesaler members (CASL scope).",
        )
    )

    # -- Fluid Power Distribution Association (Canada/US members).
    registry.register(
        SourceSeed(
            adapter=JsonLdListingAdapter("fpda_members", Vertical.FLUID_POWER, None),
            urls=["https://www.fpda.org/members/member-directory"],
            notes="Motion control / fluid power distributor members.",
        )
    )

    # -- HARDI: HVAC distributors association.
    registry.register(
        SourceSeed(
            adapter=CSVFeedAdapter("hardi_members", Vertical.HVAC, None),
            urls=["https://www.hardinet.org/member-directory"],
            notes="HVAC wholesaler members across US and Canada.",
        )
    )

    return registry
