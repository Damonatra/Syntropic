"""Polite, resilient directory scraping + the ingestion orchestrator.

The :class:`Fetcher` enforces robots.txt, per-host token-bucket rate limits,
bounded retries with exponential backoff, and a hard concurrency ceiling.
The :class:`DirectoryScraper` walks the source registry, parses listings,
normalises them into :class:`~vertebra.models.domain.CompanyRecord` objects
and applies the Syntropic corridor filter (PVF/Electrical/HVAC/Fluid Power,
$10M–$150M revenue, US & Canada).
"""

from __future__ import annotations

import asyncio
import random
import time
import urllib.robotparser
from collections import defaultdict
from dataclasses import dataclass
from typing import AsyncIterator
from urllib.parse import urljoin, urlparse

import httpx

from vertebra.config.settings import ScrapingSettings, get_settings
from vertebra.ingestion.normalizer import (
    classify_vertical,
    corridor_check,
    detect_region,
    registrable_domain,
)
from vertebra.ingestion.sources import ParsedListing, SourceRegistry, default_registry
from vertebra.logging_conf import get_logger
from vertebra.models.domain import CompanyRecord, Region, Vertical, utcnow

log = get_logger("ingestion.scraper")


# --------------------------------------------------------------------------- #
# Rate limiting
# --------------------------------------------------------------------------- #


class TokenBucket:
    """Classic token-bucket limiter, one instance per host."""

    def __init__(self, rate_per_sec: float) -> None:
        self.rate = rate_per_sec
        self.capacity = max(1.0, rate_per_sec)
        self._tokens = self.capacity
        self._updated = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                self._tokens = min(self.capacity, self._tokens + (now - self._updated) * self.rate)
                self._updated = now
                if self._tokens >= 1:
                    self._tokens -= 1
                    return
                await asyncio.sleep((1 - self._tokens) / self.rate)


# --------------------------------------------------------------------------- #
# HTTP fetcher
# --------------------------------------------------------------------------- #


class Fetcher:
    """Robots-aware, rate-limited HTTP GET client for directory crawling."""

    def __init__(self, settings: ScrapingSettings | None = None) -> None:
        self._settings = settings or get_settings().scraping
        self._buckets: dict[str, TokenBucket] = defaultdict(
            lambda: TokenBucket(self._settings.host_rate_limit_rps)
        )
        self._robots: dict[str, urllib.robotparser.RobotFileParser] = {}
        self._robots_checked: set[str] = set()
        self._semaphore = asyncio.Semaphore(self._settings.max_concurrency)
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "Fetcher":
        self._client = httpx.AsyncClient(
            headers={
                "User-Agent": self._settings.user_agent,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/csv;q=0.8,*/*;q=0.7",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=httpx.Timeout(self._settings.request_timeout_sec),
            follow_redirects=True,
            proxy=self._settings.proxy_url,
            http2=True,
        )
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def get(self, url: str) -> httpx.Response:
        """GET a URL honouring robots.txt, rate limits and retries."""
        if self._client is None:
            raise RuntimeError("Fetcher must be used as an async context manager")
        host = urlparse(url).netloc
        await self._ensure_robots(host, url)

        last_error: Exception | None = None
        for attempt in range(self._settings.max_retries + 1):
            await self._buckets[host].acquire()
            async with self._semaphore:
                try:
                    response = await self._client.get(url)
                except (httpx.HTTPError, httpx.StreamError) as exc:
                    last_error = exc
                else:
                    if response.status_code in (429, 500, 502, 503, 504):
                        last_error = httpx.HTTPStatusError(
                            f"transient status {response.status_code}", request=response.request, response=response
                        )
                    else:
                        response.raise_for_status()
                        return response
            backoff = min(30.0, 2**attempt) + random.uniform(0, 1.5)
            log.warning(
                "fetch_retry", url=url, attempt=attempt + 1, backoff_sec=round(backoff, 2), error=str(last_error)
            )
            await asyncio.sleep(backoff)
        raise RuntimeError(f"fetch failed after {self._settings.max_retries + 1} attempts: {url}") from last_error

    async def _ensure_robots(self, host: str, url: str) -> None:
        if not self._settings.respect_robots_txt or host in self._robots_checked:
            return
        self._robots_checked.add(host)
        robots_url = urljoin(f"https://{host}", "/robots.txt")
        parser = urllib.robotparser.RobotFileParser()
        try:
            assert self._client is not None
            response = await self._client.get(robots_url)
            if response.status_code == 200:
                parser.parse(response.text.splitlines())
            else:
                # 4xx robots => no restrictions; 5xx => be conservative and allow with rate limit.
                parser.parse([])
        except Exception as exc:  # noqa: BLE001 - robots fetch failure must not kill the crawl
            log.warning("robots_fetch_failed", host=host, error=str(exc))
            parser.parse([])
        self._robots[host] = parser
        if not parser.can_fetch(self._settings.user_agent, url):
            raise PermissionError(f"robots.txt disallows fetch: {url}")


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class IngestionOutcome:
    """Per-source tally returned alongside the record stream."""

    source_id: str
    fetched_urls: int = 0
    parsed: int = 0
    accepted: int = 0
    rejected: int = 0
    errors: int = 0


class DirectoryScraper:
    """Ingests target directories into corridor-qualified CompanyRecords."""

    def __init__(
        self,
        registry: SourceRegistry | None = None,
        settings: ScrapingSettings | None = None,
    ) -> None:
        self._registry = registry or default_registry()
        self._settings = settings or get_settings().scraping

    async def scrape(
        self, source_ids: list[str] | None = None
    ) -> AsyncIterator[tuple[CompanyRecord, IngestionOutcome]]:
        """Yield ``(record, outcome)`` for every corridor-qualified company.

        ``outcome`` accumulates per-source statistics as the crawl proceeds —
        callers persisting records can also persist the tally.
        """
        selected = source_ids or self._registry.ids()
        async with Fetcher(self._settings) as fetcher:
            for source_id in selected:
                if source_id not in self._registry.seeds:
                    log.warning("unknown_source", source_id=source_id)
                    continue
                seed = self._registry.get(source_id)
                outcome = IngestionOutcome(source_id=source_id)
                for url in seed.urls:
                    try:
                        response = await fetcher.get(url)
                        outcome.fetched_urls += 1
                    except (RuntimeError, PermissionError, httpx.HTTPError) as exc:
                        outcome.errors += 1
                        log.error("source_fetch_failed", source_id=source_id, url=url, error=str(exc))
                        continue
                    try:
                        listings = seed.adapter.parse(
                            response.text, response.headers.get("content-type", "")
                        )
                    except Exception as exc:  # noqa: BLE001 - parser isolation
                        outcome.errors += 1
                        log.error("source_parse_failed", source_id=source_id, url=url, error=str(exc))
                        continue
                    outcome.parsed += len(listings)
                    for listing in listings:
                        record = self._normalise(listing, source_id=seed.adapter.id, source_url=url,
                                                 vertical_hint=seed.adapter.vertical_hint,
                                                 region_hint=seed.adapter.region_hint)
                        accepted, reason = corridor_check(record)
                        if accepted:
                            outcome.accepted += 1
                            yield record, outcome
                        else:
                            outcome.rejected += 1
                            log.debug("corridor_rejected", source_id=source_id, name=record.name, reason=reason)

    # ------------------------------------------------------------- normalise
    def _normalise(
        self,
        listing: ParsedListing,
        *,
        source_id: str,
        source_url: str,
        vertical_hint: Vertical | None,
        region_hint: Region | None,
    ) -> CompanyRecord:
        """Turn a parsed listing into a normalised, deduped CompanyRecord."""
        domain = registrable_domain(listing.domain_hint or listing.website or "")
        description = listing.description or listing.address_text
        vertical = vertical_hint or classify_vertical(listing.name, description)
        region = (
            region_hint
            or detect_region(
                state_province=listing.state_province,
                country=listing.country,
                postal_code=listing.postal_code,
                domain=domain,
            )
        )
        revenue = None
        confidence = "unknown"
        if listing.revenue_text and listing.revenue_text.isdigit():
            revenue = int(listing.revenue_text)
            confidence = "estimated"
        return CompanyRecord(
            source=source_id,
            source_url=source_url,
            name=listing.name.strip(),
            domain=domain,
            website=listing.website,
            vertical=vertical,
            region=region,
            city=listing.city,
            state_province=listing.state_province,
            country=listing.country or ("Canada" if region is Region.CA else "United States" if region is Region.US else None),
            postal_code=listing.postal_code,
            employee_count=listing.employee_count,
            revenue_estimate_usd=revenue,
            revenue_confidence=confidence,
            detected_erp=listing.erp_hint,
            raw_excerpt=(description or "")[:500],
            scraped_at=utcnow(),
        )


async def run_ingestion_sample(source_ids: list[str] | None = None, limit: int = 25) -> list[CompanyRecord]:
    """Convenience coroutine for API/worker callers that want a bounded batch."""
    scraper = DirectoryScraper()
    records: list[CompanyRecord] = []
    async for record, _outcome in scraper.scrape(source_ids):
        records.append(record)
        if len(records) >= limit:
            break
    return records
