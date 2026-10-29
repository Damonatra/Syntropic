"""Module 5 — ERP & Competitor Tech Stack Profiler.

Crawls a prospect's public web surface and classifies the exact ERP /
quoting stack in use, then attaches a structured ``erp_metadata`` JSON
object to the prospect profile in Neon Postgres.

Evidence sources
----------------
1. Domain crawl  — static HTML on RFQ/quote/contact/product paths plus
   ``<meta name="generator">`` tags (httpx, politeness-capped).
2. HTTP headers  — ``Server``, ``X-Powered-By``, ``X-AspNet-Version``, …
3. TLS metadata  — live certificate issuer / SANs (asyncio + stdlib ssl).
4. Job boards    — Greenhouse / Lever / Ashby public posting APIs scanned
   for ERP keywords ("Prophet 21", "Epicor", "Infor", "SAP", "NetSuite", …).
   A company *hiring* around an ERP is the strongest intent signal there is.

Outputs
-------
* ``prospects.erp_metadata``       — full ERPMetadata JSONB document
* ``prospects.detected_erp``       — asserted ERP name (COALESCE-protected)
* ``prospects.quote_portal_type``  — mailto / PDF form / legacy portal / API
* ``recommended_pitch_angle``      — ERP-integration-specific talking track
* ``outbox`` event                 — ``prospect.erp_profiled``
* Qdrant payload patch             — optional mirror for kNN filtering

Usage
-----
    python -m vertebra.enrichment.erp_profiler --prospect-id <uuid>
    python -m vertebra.enrichment.erp_profiler --batch --limit 25
"""

from __future__ import annotations

import asyncio
import html as _html
import json
import re
import ssl
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

import httpx

from vertebra.config.settings import ErpProfilerSettings, ScrapingSettings, get_settings
from vertebra.db.outbox import OutboxStore
from vertebra.db.pool import Database
from vertebra.logging_conf import get_logger
from vertebra.models.domain import ERPMetadata, ERPSignal, QuotePortalType
from vertebra.models.errors import ProfilerError

log = get_logger("enrichment.erp_profiler")

# --------------------------------------------------------------------------- #
# ERP signature registry — each pattern is matched case-insensitively.
# --------------------------------------------------------------------------- #


@dataclass(slots=True, frozen=True)
class ERPSignature:
    """One ERP fingerprint: patterns, vertical affinity and its pitch line."""

    name: str
    family: str
    patterns: tuple[re.Pattern[str], ...]
    verticals: frozenset[str]
    integration_surface: str
    pitch_line: str


def _sig(
    name: str,
    family: str,
    expressions: tuple[str, ...],
    verticals: tuple[str, ...],
    integration: str,
    pitch: str,
) -> ERPSignature:
    return ERPSignature(
        name=name,
        family=family,
        patterns=tuple(re.compile(p, re.IGNORECASE) for p in expressions),
        verticals=frozenset(verticals),
        integration_surface=integration,
        pitch_line=pitch,
    )


_ALL = ("pvf", "electrical", "hvac", "fluid_power")

ERP_SIGNATURES: dict[str, ERPSignature] = {
    sig.name: sig
    for sig in (
        _sig(
            "Prophet 21", "Epicor", (r"prophet\s?-?21", r"\bP21\b"),
            ("pvf", "electrical", "hvac", "fluid_power"),
            "Epicor Commerce Connect + P21 REST APIs",
            "P21-native RFQ intake: quotes out in minutes, not days, without a rip-and-replace project.",
        ),
        _sig(
            "Epicor Eclipse", "Epicor",
            (r"epicor['’']?s?\s+eclipse", r"\beclipse\b(?=[^\n]{0,60}(?:pvf|distribut|wholesal|supply))"),
            ("pvf", "electrical"),
            "Eclipse REST/COM integration surface",
            "Eclipse-native quoting kills the re-keying between the RFQ inbox and order entry.",
        ),
        _sig(
            "Epicor Kinetic", "Epicor",
            (r"epicor\s+kinetic", r"\bkinetic\b(?=[^\n]{0,40}(?:erp|manufactur))"),
            _ALL,
            "Kinetic REST + Epicor function APIs",
            "Kinetic-grade quote automation without another six-figure implementation cycle.",
        ),
        _sig(
            "Infor CloudSuite", "Infor",
            (r"infor\s+cloudsuite", r"infor\s+(m3|ln|distribution)"),
            ("hvac", "electrical", "pvf"),
            "Infor OS / ION APIs",
            "ION-wired quoting: Infor data in, same-day quotes out.",
        ),
        _sig(
            "SAP", "SAP",
            (
                r"\bSAP\s+(S/?4|HANA|Business\s+One|B1)\b",
                r"\bSAP\b(?=[^\n]{0,50}(?:ERP|integration|landscape|module))",
            ),
            _ALL,
            "SAP OData / RFC middleware",
            "SAP-grade pricing discipline without SAP-grade quote friction.",
        ),
        _sig(
            "NetSuite", "Oracle NetSuite", (r"\bnetsuite\b", r"\bsuitecommerce\b"),
            _ALL,
            "SuiteTalk REST/SOAP + SuiteCommerce",
            "NetSuite quoting on autopilot: vendor SPA pricing enforced at the moment of quote.",
        ),
        _sig(
            "Dynamics 365", "Microsoft", (r"dynamics\s?365", r"\bD365\b", r"business\s+central"),
            _ALL,
            "Dataverse / OData bindings",
            "D365-native quote intake: your Business Central data, zero re-keying.",
        ),
        _sig(
            "Acumatica", "Acumatica", (r"\bacumatica\b",), _ALL,
            "Acumatica REST contract-based APIs",
            "Acumatica-native quoting: same-day turnaround as a feature, not a favour.",
        ),
        _sig(
            "Sage", "Sage", (r"\bsage\s+(x3|100|200|300|intacct)\b", r"\bsage\b(?=[^\n]{0,30}erp)"),
            _ALL,
            "Sage APIs + spreadsheet bridging",
            "Sage-based quoting without the spreadsheet bridge that leaks margin.",
        ),
        _sig(
            "Syspro", "Syspro", (r"\bsyspro\b",), ("pvf", "fluid_power", "electrical"),
            "Syspro business objects / OData",
            "Syspro-native quoting for branch-scale RFQ volume.",
        ),
        _sig(
            "QuickBooks", "Intuit", (r"\bquickbooks\b",), _ALL,
            "QuickBooks + spreadsheets — the classic $10M–$150M ceiling",
            "When quoting lives in QuickBooks and spreadsheets, every RFQ is a latency "
            "event — we close that gap in days.",
        ),
        _sig(
            "Odoo", "Odoo", (r"\bodoo\b",), _ALL,
            "Odoo JSON-RPC / XML-RPC",
            "Odoo-native quote automation before headcount becomes the bottleneck.",
        ),
    )
}

# --------------------------------------------------------------------------- #
# Portal classification markers
# --------------------------------------------------------------------------- #

_LEGACY_PORTAL_MARKERS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"__VIEWSTATE",
        r"aspnetForm",
        r"jquery-1\.\d",
        r"\bweb-to-lead\b",
        r"salesforce",
        r"\.aspx\b",
        r"sharepoint",
    )
)

_MODERN_PORTAL_MARKERS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"/api/(quote|rfq|pricing)",
        r"\bconfigurator\b",
        r"quote-?builder",
        r"\bcpq\b",
        r"epicor\s+commerce",
        r"suitecommerce",
    )
)

_INTERESTING_HEADERS = frozenset({"server", "x-powered-by", "x-aspnet-version", "via", "x-generator"})
_MAILTO_HINTS = ("quote", "rfq", "sales", "pricing", "estimate")
_PDF_HINTS = ("quote", "rfq", "form", "credit", "request")

_HREF_RE = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
_GENERATOR_RE = re.compile(
    r"""<meta[^>]+name\s*=\s*["']generator["'][^>]+content\s*=\s*["']([^"']+)["']""",
    re.IGNORECASE,
)

_SOURCE_WEIGHTS: dict[str, float] = {
    "page_body": 1.0,
    "page_meta": 0.5,
    "http_header": 0.6,
    "job_posting": 1.15,
}

_GREENHOUSE_URL = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
_LEVER_URL = "https://api.lever.co/v0/postings/{slug}?mode=json"
_ASHBY_URL = "https://api.ashbyhq.com/posting-api/job-board/{slug}"


# --------------------------------------------------------------------------- #
# Probe containers
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class PageFetch:
    url: str
    status: int
    body: str
    headers: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class DomainProbe:
    base_url: str
    pages: list[PageFetch] = field(default_factory=list)
    mailto_hits: list[str] = field(default_factory=list)
    pdf_form_hits: list[str] = field(default_factory=list)
    meta_generators: list[str] = field(default_factory=list)
    header_evidence: list[str] = field(default_factory=list)

    @property
    def bodies(self) -> str:
        return "\n".join(page.body for page in self.pages)


@dataclass(slots=True)
class TlsMetadata:
    issuer: str | None
    not_after: str | None
    san_domains: list[str]


@dataclass(slots=True)
class JobScan:
    boards_tried: list[str] = field(default_factory=list)
    postings_scanned: int = 0
    signals: list[ERPSignal] = field(default_factory=list)


def _strip_html(raw: str, cap: int = 4_000) -> str:
    text = re.sub(r"<[^>]+>", " ", raw)
    text = _html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()[:cap]


def _snippet(text: str, match: re.Match[str], radius: int = 90) -> str:
    start = max(0, match.start() - radius)
    end = min(len(text), match.end() + radius)
    return re.sub(r"\s+", " ", text[start:end]).strip()[:400]


def _cert_attr(node: Any, key: str) -> str | None:
    """Extract one attribute from an ssl cert dict (issuer/subject)."""
    for group in node or ():
        for attr_key, value in group:
            if attr_key == key:
                return str(value)
    return None


# --------------------------------------------------------------------------- #
# Profiler
# --------------------------------------------------------------------------- #


class ERPProfiler:
    """Classifies a prospect's ERP stack and attaches ``erp_metadata``."""

    def __init__(
        self,
        db: Database,
        outbox: OutboxStore,
        *,
        settings: ErpProfilerSettings | None = None,
        scraping: ScrapingSettings | None = None,
        qdrant_index: Any | None = None,
    ) -> None:
        self._db = db
        self._outbox = outbox
        self._settings = settings or get_settings().erp_profiler
        self._scraping = scraping or get_settings().scraping
        self._qdrant_index = qdrant_index
        self._http = httpx.AsyncClient(
            headers={"User-Agent": self._scraping.user_agent, "Accept-Language": "en-US,en;q=0.9"},
            timeout=httpx.Timeout(self._scraping.request_timeout_sec, connect=8.0),
            follow_redirects=True,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------ public API
    async def profile_prospect(self, prospect_id: str) -> ERPMetadata | None:
        """Profile one stored prospect and persist the result. Idempotent."""
        row = await self._db.fetchrow(
            "SELECT id, name, domain, vertical FROM prospects WHERE id = $1",
            uuid.UUID(prospect_id),
        )
        if row is None:
            raise ProfilerError("prospect not found", context={"prospect_id": prospect_id})
        if not row["domain"]:
            log.warning("erp_profile_skipped_no_domain", prospect_id=prospect_id)
            return None

        metadata = await self.profile(
            domain=str(row["domain"]),
            company_name=str(row["name"]),
            prospect_id=prospect_id,
            vertical=str(row["vertical"]) if row["vertical"] else None,
        )
        await self._persist(prospect_id, metadata)
        return metadata

    async def profile(
        self,
        *,
        domain: str,
        company_name: str,
        prospect_id: str,
        vertical: str | None,
    ) -> ERPMetadata:
        """Run all probes concurrently and classify the stack."""
        probe, tls, jobs = await asyncio.gather(
            self._probe_domain(domain),
            self._tls_metadata(domain),
            self._scan_job_boards(domain),
            return_exceptions=True,
        )
        if isinstance(probe, Exception):
            log.warning("erp_probe_failed", domain=domain, error=str(probe))
            probe = DomainProbe(base_url=f"https://{domain}")
        if isinstance(tls, Exception):
            log.debug("erp_tls_probe_failed", domain=domain, error=str(tls))
            tls = None
        if isinstance(jobs, Exception):
            log.warning("erp_job_scan_failed", domain=domain, error=str(jobs))
            jobs = JobScan()

        signals = self._collect_signals(probe, jobs)
        erp_name, erp_family, confidence = self._classify_erp(signals, vertical)
        portal, portal_evidence = self._classify_portal(probe)
        pitch = self._pitch_angle(erp_name, portal, vertical)

        metadata = ERPMetadata(
            detected_erp=erp_name,
            erp_family=erp_family,
            detection_confidence=round(min(confidence, 0.97), 2),
            quote_portal_type=portal,
            portal_evidence=portal_evidence,
            signals=signals,
            recommended_pitch_angle=pitch,
            ssl_issuer=tls.issuer if tls else None,
            job_boards_scanned=jobs.boards_tried,
            job_postings_scanned=jobs.postings_scanned,
        )
        log.info(
            "erp_profile_completed",
            prospect_id=prospect_id,
            domain=domain,
            detected_erp=erp_name,
            confidence=metadata.detection_confidence,
            portal=metadata.quote_portal_type.value,
            signals=len(signals),
        )
        return metadata

    async def profile_unprofiled(self, *, limit: int = 25) -> list[ERPMetadata | None]:
        """Batch-queue: every prospect with a domain but no erp_metadata yet."""
        rows = await self._db.fetch(
            """
            SELECT id FROM prospects
             WHERE erp_metadata IS NULL
               AND domain IS NOT NULL
               AND ingestion <> 'filtered'
             ORDER BY created_at
             LIMIT $1
            """,
            limit,
        )
        results: list[ERPMetadata | None] = []
        for row in rows:
            try:
                results.append(await self.profile_prospect(str(row["id"])))
            except Exception as exc:  # noqa: BLE001 - batch must survive bad rows
                log.exception("erp_profile_batch_item_failed", prospect_id=str(row["id"]), error=str(exc))
                results.append(None)
        return results

    # ---------------------------------------------------------- persistence
    async def _persist(self, prospect_id: str, metadata: ERPMetadata) -> None:
        async with self._db.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE prospects
                       SET erp_metadata = $2::jsonb,
                           detected_erp = COALESCE($3, detected_erp),
                           quote_portal_type = $4,
                           updated_at = now()
                     WHERE id = $1
                    """,
                    uuid.UUID(prospect_id),
                    json.dumps(metadata.model_dump(mode="json"), default=str),
                    metadata.detected_erp,
                    str(metadata.quote_portal_type.value),
                )
                await self._outbox.enqueue(
                    conn,
                    aggregate_type="prospect",
                    aggregate_id=prospect_id,
                    event_type="prospect.erp_profiled",
                    payload={
                        "detected_erp": metadata.detected_erp,
                        "erp_family": metadata.erp_family,
                        "quote_portal_type": metadata.quote_portal_type.value,
                        "confidence": metadata.detection_confidence,
                    },
                )
        if self._qdrant_index is not None and self._settings.sync_qdrant_payload:
            await self._qdrant_index.patch_payload(
                prospect_id,
                {
                    "detected_erp": metadata.detected_erp,
                    "erp_family": metadata.erp_family,
                    "quote_portal_type": metadata.quote_portal_type.value,
                    "pitch_angle": metadata.recommended_pitch_angle,
                },
            )

    # ------------------------------------------------------------ domain crawl
    async def _probe_domain(self, host: str) -> DomainProbe:
        base = f"https://{host}"
        probe = DomainProbe(base_url=base)
        for path in self._settings.crawl_paths:
            url = f"{base}{path}"
            try:
                response = await self._http.get(url)
            except httpx.HTTPError as exc:
                log.debug("erp_probe_fetch_failed", url=url, error=str(exc))
                continue
            if response.status_code != 200:
                continue
            if "html" not in response.headers.get("content-type", ""):
                continue
            body = response.text[: self._settings.page_fetch_max_bytes]
            headers = {
                k.lower(): v
                for k, v in response.headers.items()
                if k.lower() in _INTERESTING_HEADERS
            }
            probe.pages.append(PageFetch(url=str(response.url), status=200, body=body, headers=headers))
            for href in _HREF_RE.findall(body):
                low = href.lower()
                if low.startswith("mailto:") and any(hint in low for hint in _MAILTO_HINTS):
                    probe.mailto_hits.append(href[:300])
                elif low.endswith(".pdf") and any(hint in low for hint in _PDF_HINTS):
                    probe.pdf_form_hits.append(href[:300])
            gen = _GENERATOR_RE.search(body)
            if gen:
                probe.meta_generators.append(gen.group(1)[:200])
        for page in probe.pages:
            for key, value in page.headers.items():
                probe.header_evidence.append(f"{key}: {value}")
        log.debug(
            "erp_probe_summary",
            host=host,
            pages=len(probe.pages),
            mailto=len(probe.mailto_hits),
            pdf_forms=len(probe.pdf_form_hits),
        )
        return probe

    # ---------------------------------------------------------------- TLS meta
    async def _tls_metadata(self, host: str) -> TlsMetadata | None:
        context = ssl.create_default_context()
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, 443, ssl=context), timeout=self._scraping.request_timeout_sec
            )
        except Exception as exc:  # noqa: BLE001 - TLS probing is best-effort
            log.debug("erp_tls_unreachable", host=host, error=str(exc))
            return None
        try:
            cert = writer.get_extra_info("peercert") or {}
            issuer = _cert_attr(cert.get("issuer"), "organizationName") or _cert_attr(
                cert.get("issuer"), "commonName"
            )
            sans = [value for kind, value in cert.get("subjectAltName", ()) if kind == "DNS"][:16]
            return TlsMetadata(issuer=issuer, not_after=cert.get("notAfter"), san_domains=sans)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception as exc:  # noqa: BLE001 - socket already closing
                log.debug("erp_tls_close_failed", host=host, error=str(exc))

    # -------------------------------------------------------------- job boards
    async def _scan_job_boards(self, host: str) -> JobScan:
        if not self._settings.scan_job_boards:
            return JobScan()
        slug = host.split(".")[0]
        postings: list[tuple[str, str, str]] = []
        boards_tried: list[str] = []

        async def _fetch(board: str, url: str) -> None:
            try:
                response = await self._http.get(url, timeout=self._settings.job_board_timeout_sec)
            except httpx.HTTPError as exc:
                log.debug("erp_job_board_unreachable", board=board, slug=slug, error=str(exc))
                return
            boards_tried.append(board)
            if response.status_code != 200:
                return
            try:
                data: Any = response.json()
            except ValueError:
                return
            if board == "greenhouse" and isinstance(data, dict):
                for job in data.get("jobs", [])[:50]:
                    postings.append(
                        (
                            str(job.get("title", "")),
                            _strip_html(str(job.get("content", "") or "")),
                            f"https://boards.greenhouse.io/{slug}/jobs/{job.get('id', '')}",
                        )
                    )
            elif board == "lever" and isinstance(data, list):
                for posting in data[:50]:
                    text = posting.get("descriptionPlain") or _strip_html(
                        str(posting.get("description", "") or "")
                    )
                    postings.append((str(posting.get("text", "")), text, str(posting.get("hostedUrl", ""))))
            elif board == "ashby" and isinstance(data, dict):
                for job in data.get("jobs", [])[:50]:
                    text = job.get("descriptionPlain") or _strip_html(
                        str(job.get("descriptionHtml", "") or "")
                    )
                    postings.append((str(job.get("title", "")), text, str(job.get("jobUrl", ""))))

        await asyncio.gather(
            _fetch("greenhouse", _GREENHOUSE_URL.format(slug=slug)),
            _fetch("lever", _LEVER_URL.format(slug=slug)),
            _fetch("ashby", _ASHBY_URL.format(slug=slug)),
        )

        signals: list[ERPSignal] = []
        for title, text, url in postings:
            haystack = f"{title}\n{text}"
            for signature in ERP_SIGNATURES.values():
                for pattern in signature.patterns:
                    match = pattern.search(haystack)
                    if match:
                        signals.append(
                            ERPSignal(
                                source="job_posting",
                                keyword=signature.name,
                                snippet=_snippet(haystack, match),
                                url=url or None,
                                weight=_SOURCE_WEIGHTS["job_posting"],
                            )
                        )
                        break  # one hit per signature per posting
        log.debug(
            "erp_job_scan_summary", slug=slug, boards=boards_tried,
            postings=len(postings), hits=len(signals),
        )
        return JobScan(boards_tried=boards_tried, postings_scanned=len(postings), signals=signals[:20])

    # ----------------------------------------------------------------- signals
    def _collect_signals(self, probe: DomainProbe, jobs: JobScan) -> list[ERPSignal]:
        signals: list[ERPSignal] = []
        per_signature: dict[str, int] = defaultdict(int)

        for signature in ERP_SIGNATURES.values():
            for page in probe.pages:
                if per_signature[signature.name] >= 2:
                    break
                for pattern in signature.patterns:
                    match = pattern.search(page.body)
                    if match:
                        signals.append(
                            ERPSignal(
                                source="page_body",
                                keyword=signature.name,
                                snippet=_snippet(page.body, match),
                                url=page.url,
                                weight=_SOURCE_WEIGHTS["page_body"],
                            )
                        )
                        per_signature[signature.name] += 1
                        break

        generators = " ".join(probe.meta_generators)
        if generators:
            for signature in ERP_SIGNATURES.values():
                if per_signature[signature.name] >= 2:
                    continue
                for pattern in signature.patterns:
                    match = pattern.search(generators)
                    if match:
                        signals.append(
                            ERPSignal(
                                source="page_meta",
                                keyword=signature.name,
                                snippet=_snippet(generators, match),
                                url=probe.base_url,
                                weight=_SOURCE_WEIGHTS["page_meta"],
                            )
                        )
                        per_signature[signature.name] += 1
                        break

        header_blob = " | ".join(probe.header_evidence)
        if header_blob:
            for signature in ERP_SIGNATURES.values():
                for pattern in signature.patterns:
                    match = pattern.search(header_blob)
                    if match:
                        signals.append(
                            ERPSignal(
                                source="http_header",
                                keyword=signature.name,
                                snippet=_snippet(header_blob, match),
                                url=probe.base_url,
                                weight=_SOURCE_WEIGHTS["http_header"],
                            )
                        )
                        break

        signals.extend(jobs.signals)
        return signals[:40]

    # ------------------------------------------------------------- classifiers
    def _classify_erp(
        self, signals: list[ERPSignal], vertical: str | None
    ) -> tuple[str | None, str | None, float]:
        scores: dict[str, float] = defaultdict(float)
        sources: dict[str, set[str]] = defaultdict(set)
        hits: dict[str, int] = defaultdict(int)

        for signal in signals:
            signature = ERP_SIGNATURES.get(signal.keyword)
            if signature is None:
                continue
            scores[signal.keyword] += signal.weight * _SOURCE_WEIGHTS.get(signal.source, 1.0)
            sources[signal.keyword].add(signal.source)
            hits[signal.keyword] += 1

        best_name: str | None = None
        best_score = 0.0
        for name, score in scores.items():
            signature = ERP_SIGNATURES[name]
            adjusted = score + (0.25 if vertical and vertical.lower() in signature.verticals else 0.0)
            if adjusted > best_score:
                best_name, best_score = name, adjusted

        if best_name is None or best_score < self._settings.detection_confidence_floor:
            return None, None, 0.0

        confidence = 0.45 + 0.12 * len(sources[best_name]) + 0.05 * max(0, hits[best_name] - 1)
        return best_name, ERP_SIGNATURES[best_name].family, confidence

    def _classify_portal(self, probe: DomainProbe) -> tuple[QuotePortalType, list[str]]:
        bodies = probe.bodies.lower()
        modern_hits = [m.group(0) for marker in _MODERN_PORTAL_MARKERS for m in marker.finditer(bodies)]
        legacy_hits = [m.group(0) for marker in _LEGACY_PORTAL_MARKERS for m in marker.finditer(bodies)]

        if modern_hits:
            return QuotePortalType.MODERN_QUOTE_API, [
                f"modern quote surface markers: {sorted(set(modern_hits))[:3]}"
            ]
        if legacy_hits:
            return QuotePortalType.LEGACY_PORTAL, [
                f"legacy portal markers: {sorted(set(legacy_hits))[:3]}",
                *(probe.header_evidence[:2]),
            ]
        if probe.pdf_form_hits:
            return QuotePortalType.STATIC_PDF_FORM, [f"PDF quote forms: {probe.pdf_form_hits[:2]}"]
        if probe.mailto_hits:
            return QuotePortalType.MANUAL_MAILTO, [f"mailto RFQ links: {probe.mailto_hits[:2]}"]
        return QuotePortalType.UNDETERMINED, []

    def _pitch_angle(
        self, erp_name: str | None, portal: QuotePortalType, vertical: str | None
    ) -> str:
        if erp_name:
            signature = ERP_SIGNATURES[erp_name]
            base = f"{signature.pitch_line} (integration surface: {signature.integration_surface}.)"
        else:
            base = (
                "No ERP fingerprint surfaced — lead with RFQ latency math and let "
                "the audit preview do the talking."
            )

        portal_line = {
            QuotePortalType.MANUAL_MAILTO: (
                "Their RFQ inbox is the pricing bottleneck: every quote waits on an "
                "inbox sweep and a spreadsheet."
            ),
            QuotePortalType.STATIC_PDF_FORM: (
                "PDF quote forms mean re-keying, version drift and quotes that never get sent."
            ),
            QuotePortalType.LEGACY_PORTAL: (
                "A legacy portal customers avoid is friction their competitors are already monetizing."
            ),
            QuotePortalType.MODERN_QUOTE_API: (
                "Modern quote plumbing exists — the gap is cross-vendor SPA enforcement "
                "and pricing intelligence on top."
            ),
            QuotePortalType.UNDETERMINED: (
                "Quote workflow looks manual or opaque — probe RFQ turnaround on the first call."
            ),
        }[portal]

        vertical_line = {
            "pvf": "Anchor on scheduled-price-agreement (SPA) leakage and mill-to-counter price drift.",
            "electrical": "Anchor on distributor price-protection windows and project-quote turnaround.",
            "hvac": "Anchor on seasonal surge quoting and stock-out quote abandonment.",
            "fluid_power": "Anchor on hydraulic spec turnaround and OEM cross-reference time.",
        }.get((vertical or "").lower(), "Anchor on manual RFQ latency and unapplied vendor SPAs.")

        return f"{base} {portal_line} {vertical_line}"


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


async def _run(args: list[str]) -> int:
    from vertebra.logging_conf import configure_logging

    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    db = Database(settings.database)
    await db.connect()
    outbox = OutboxStore(db)
    profiler = ERPProfiler(db, outbox)
    try:
        if args.batch:
            results = await profiler.profile_unprofiled(limit=args.limit)
            profiled = sum(1 for r in results if r is not None)
            log.info("erp_profile_batch_done", requested=len(results), profiled=profiled)
            print(json.dumps({"requested": len(results), "profiled": profiled}))
        else:
            if not args.prospect_id:
                raise ProfilerError("either --prospect-id or --batch is required")
            metadata = await profiler.profile_prospect(args.prospect_id)
            payload = metadata.model_dump(mode="json") if metadata else {"skipped": True}
            print(json.dumps(payload, indent=2, default=str))
    finally:
        await profiler.aclose()
        await db.close()
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Module 5 — ERP & tech-stack profiler")
    parser.add_argument("--prospect-id", help="Profile a single stored prospect")
    parser.add_argument("--batch", action="store_true", help="Profile every prospect missing erp_metadata")
    parser.add_argument("--limit", type=int, default=25, help="Batch size")
    sys.exit(asyncio.run(_run(parser.parse_args())))
