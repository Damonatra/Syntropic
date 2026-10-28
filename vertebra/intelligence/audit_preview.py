"""Module 6 — Automated Mock Audit Screenshot Generator.

Captures a high-resolution headless screenshot of the prospect's public
RFQ / contact / catalog page (Playwright, Chromium, 2× device scale), then
composites a soft-tactile audit calculator widget on top of the image that
displays the estimated annual net-margin leakage for their vertical.

Visual standard
---------------
The widget is composed strictly from the achromatic Steep design tokens in
``DESIGN.md`` — Paper White surface, hairline border, soft 10%-opacity
shadow, 20px radius — honouring the standing "only shades of grey and
black" doctrine. No chromatic color exists anywhere in the pipeline.

Outputs
-------
* ``prospects.audit_image_url`` — public CDN link, embedded dynamically in
  Channel A cold emails and the Josias high-touch task queue.
* ``outbox`` event — ``audit.preview_generated``.

Storage
-------
* ``s3``    — any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO) served
  behind ``audit_preview.cdn_base_url``.
* ``local`` — a writable directory the portal/CDN mounts at
  ``<portal_base_url>/assets``.

Usage
-----
    python -m vertebra.intelligence.audit_preview --prospect-id <uuid>
    python -m vertebra.intelligence.audit_preview --batch --limit 20

Requires: ``playwright install chromium`` once per worker image.
"""

from __future__ import annotations

import asyncio
import io
import uuid as uuid_mod
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from vertebra.config.settings import AuditPreviewSettings, ScrapingSettings, get_settings
from vertebra.db.outbox import OutboxStore
from vertebra.db.pool import Database
from vertebra.logging_conf import get_logger
from vertebra.models.domain import AuditPreview, LeakageEstimate
from vertebra.models.errors import AuditPreviewError

log = get_logger("intelligence.audit_preview")

# --------------------------------------------------------------------------- #
# Deterministic leakage model — vertical benchmark table (v1)
# --------------------------------------------------------------------------- #
#
# The estimator is deliberately transparent: monthly RFQ volume is scaled
# from the prospect's revenue estimate, then annual leakage = volume × 12 ×
# average order value × gross margin × capture-loss rate. The benchmark
# rows are conservative published-band values for distribution verticals and
# the full formula travels with every estimate (`methodology`) so any figure
# on an audit image can be defended line by line.

LEAKAGE_BENCHMARKS: dict[str, dict[str, float]] = {
    "pvf": {
        "rfqs_per_month_per_10m": 90, "avg_order_value": 4_200, "gross_margin": 0.27,
        "capture_loss": 0.18, "quote_delay_hours": 26,
    },
    "electrical": {
        "rfqs_per_month_per_10m": 85, "avg_order_value": 1_800, "gross_margin": 0.22,
        "capture_loss": 0.15, "quote_delay_hours": 18,
    },
    "hvac": {
        "rfqs_per_month_per_10m": 70, "avg_order_value": 3_100, "gross_margin": 0.31,
        "capture_loss": 0.16, "quote_delay_hours": 22,
    },
    "fluid_power": {
        "rfqs_per_month_per_10m": 55, "avg_order_value": 5_200, "gross_margin": 0.33,
        "capture_loss": 0.19, "quote_delay_hours": 30,
    },
}

#: Conservative fallback for prospects without a known vertical.
_DEFAULT_BENCHMARK: dict[str, float] = {
    "rfqs_per_month_per_10m": 65, "avg_order_value": 2_600, "gross_margin": 0.24,
    "capture_loss": 0.15, "quote_delay_hours": 24,
}

#: Midpoint of the standing $10M–$150M ICP corridor when revenue is unknown.
_DEFAULT_REVENUE_BASIS: float = 60_000_000.0

_VERTICAL_LABELS: dict[str, str] = {
    "pvf": "PVF",
    "electrical": "Electrical",
    "hvac": "HVAC",
    "fluid_power": "Fluid Power",
}


def estimate_revenue_basis(revenue_estimate_usd: int | None) -> float:
    """Revenue the leakage figure is scaled against (ICP midpoint fallback)."""
    return float(revenue_estimate_usd) if revenue_estimate_usd else _DEFAULT_REVENUE_BASIS


def build_leakage_estimate(
    *, vertical: str | None, revenue_estimate_usd: int | None
) -> LeakageEstimate:
    """Deterministic annual net-margin leakage estimate for one prospect."""
    benchmark = LEAKAGE_BENCHMARKS.get((vertical or "").lower(), _DEFAULT_BENCHMARK)
    revenue_basis = estimate_revenue_basis(revenue_estimate_usd)
    monthly_rfq_volume = max(1, int(round(benchmark["rfqs_per_month_per_10m"] * revenue_basis / 10_000_000)))
    annual_leakage = (
        monthly_rfq_volume
        * 12
        * benchmark["avg_order_value"]
        * benchmark["gross_margin"]
        * benchmark["capture_loss"]
    )
    methodology = (
        f"{monthly_rfq_volume} RFQs/mo × 12 × ${benchmark['avg_order_value']:,.0f} avg order × "
        f"{benchmark['gross_margin']:.0%} gross margin × {benchmark['capture_loss']:.0%} capture loss "
        f"on manually-handled quotes (benchmark table audit_preview/v1, vertical="
        f"{(vertical or 'unknown').lower()}, revenue basis ${revenue_basis / 1e6:.1f}M)"
    )
    return LeakageEstimate(
        annual_net_margin_leakage=round(annual_leakage, 2),
        revenue_basis_usd=revenue_basis,
        monthly_rfq_volume=monthly_rfq_volume,
        avg_order_value_usd=benchmark["avg_order_value"],
        gross_margin_pct=benchmark["gross_margin"],
        capture_loss_rate=benchmark["capture_loss"],
        avg_quote_delay_hours=benchmark["quote_delay_hours"],
        methodology=methodology,
    )


# --------------------------------------------------------------------------- #
# Playwright capture
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class _CaptureResult:
    png: bytes
    width: int
    height: int


class ScreenshotCapture:
    """Headless Chromium capture at high resolution (device-scale 2×)."""

    def __init__(self, settings: AuditPreviewSettings | None = None) -> None:
        self._settings = settings or get_settings().audit_preview

    async def capture(self, url: str) -> _CaptureResult:
        try:
            from playwright.async_api import TimeoutError as PWTimeoutError
            from playwright.async_api import async_playwright
        except ImportError as exc:  # pragma: no cover - environment guard
            raise AuditPreviewError(
                "playwright is not installed — run 'playwright install chromium'"
            ) from exc

        viewport = {"width": self._settings.viewport_width, "height": self._settings.viewport_height}
        dsf = self._settings.device_scale_factor
        try:
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(
                    headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"]
                )
                try:
                    page = await browser.new_page(viewport=viewport, device_scale_factor=dsf)
                    try:
                        await page.goto(
                            url, wait_until="networkidle", timeout=self._settings.navigation_timeout_ms
                        )
                    except PWTimeoutError:
                        log.warning("capture_networkidle_timeout_falling_back", url=url)
                        await page.goto(url, wait_until="load", timeout=20_000)
                    # Nudge lazy-loaded catalog imagery, then settle at the top.
                    await page.evaluate("window.scrollTo(0, Math.floor(document.body.scrollHeight / 4))")
                    await page.wait_for_timeout(900)
                    await page.evaluate("window.scrollTo(0, 0)")
                    await page.wait_for_timeout(350)
                    png = await page.screenshot(type="png")
                    return _CaptureResult(
                        png=png, width=viewport["width"] * dsf, height=viewport["height"] * dsf
                    )
                finally:
                    await browser.close()
        except AuditPreviewError:
            raise
        except Exception as exc:  # noqa: BLE001 - normalise playwright errors
            raise AuditPreviewError(
                f"capture failed for {url}: {type(exc).__name__}: {exc}", context={"url": url}
            ) from exc


# --------------------------------------------------------------------------- #
# Widget overlay — Steep design tokens, achromatic only
# --------------------------------------------------------------------------- #


class _Tokens:
    """Achromatic subset of the DESIGN.md (Steep) palette."""

    INK = (23, 25, 28, 255)        # #17191c ink black — primary text
    PAPER = (255, 255, 255, 255)   # #ffffff paper white — card surface
    MIST = (242, 242, 243, 255)    # #f2f2f3 mist gray — gauge track
    SLATE = (119, 123, 134, 255)   # #777b86 slate gray — captions
    ASH = (151, 151, 153, 255)     # #979799 ash gray — eyebrow/footer
    SMOKE = (163, 166, 175, 255)   # #a3a6af smoke gray — meta rows
    HAIRLINE = (23, 25, 28, 22)    # ink at ~8% — artifact border
    SHADOW = (10, 12, 15, 26)      # ink at ~10% — floating artifact shadow


_FONT_CANDIDATES_BOLD = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
)
_FONT_CANDIDATES_REGULAR = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
)


class AuditWidgetOverlay:
    """Composites the soft-tactile audit calculator card onto a screenshot."""

    # Geometry is designed in CSS pixels and scaled by the device scale factor.
    CARD_W = 480
    CARD_H = 224
    RADIUS = 20
    MARGIN = 40

    def __init__(self, settings: AuditPreviewSettings | None = None) -> None:
        self._settings = settings or get_settings().audit_preview
        self._font_cache: dict[tuple[str, int], Any] = {}

    # ------------------------------------------------------------------ fonts
    def _font(self, size_px: int, *, bold: bool = False) -> Any:
        from PIL import ImageFont

        candidates = _FONT_CANDIDATES_BOLD if bold else _FONT_CANDIDATES_REGULAR
        key = (candidates[0], size_px)
        if key not in self._font_cache:
            for path in candidates:
                try:
                    self._font_cache[key] = ImageFont.truetype(path, size_px)
                    break
                except OSError:
                    continue
            else:
                self._font_cache[key] = ImageFont.load_default()
        return self._font_cache[key]

    @staticmethod
    def _tracked_text(
        draw: Any, xy: tuple[int, int], text: str, font: Any, *, fill: tuple, tracking: int
    ) -> None:
        """Letter-spaced text (editorial eyebrow styling)."""
        x, y = xy
        for char in text:
            draw.text((x, y), char, font=font, fill=fill)
            x += draw.textlength(char, font=font) + tracking

    # ------------------------------------------------------------------ apply
    def apply(
        self,
        png: bytes,
        *,
        company_name: str,
        domain: str | None,
        vertical: str | None,
        estimate: LeakageEstimate,
        width: int,
        height: int,
    ) -> bytes:
        from PIL import Image, ImageDraw, ImageFilter

        base = Image.open(io.BytesIO(png)).convert("RGBA")
        scale = base.width / self._settings.viewport_width
        card_w, card_h = int(self.CARD_W * scale), int(self.CARD_H * scale)
        margin = int(self.MARGIN * scale)
        radius = int(self.RADIUS * scale)
        x0, y0 = margin, max(0, base.height - card_h - margin)

        # Floating-artifact shadow at ~10% opacity (DESIGN.md elevation spec).
        shadow_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
        ImageDraw.Draw(shadow_layer).rounded_rectangle(
            [x0, y0 + int(16 * scale), x0 + card_w, y0 + card_h + int(16 * scale)],
            radius=radius,
            fill=_Tokens.SHADOW,
        )
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(int(11 * scale)))
        layer = shadow_layer

        draw = ImageDraw.Draw(layer)
        draw.rounded_rectangle(
            [x0, y0, x0 + card_w, y0 + card_h],
            radius=radius,
            fill=_Tokens.PAPER,
            outline=_Tokens.HAIRLINE,
            width=max(1, int(scale)),
        )

        pad = int(24 * scale)
        cx = x0 + pad
        eyebrow_font = self._font(max(9, int(11 * scale)))
        figure_font = self._font(max(20, int(38 * scale)), bold=True)
        caption_font = self._font(max(9, int(13 * scale)))
        meta_font = self._font(max(8, int(11 * scale)))
        footer_font = self._font(max(8, int(10 * scale)))

        # Eyebrow — letter-spaced category label (typographic tag, no badge).
        self._tracked_text(
            draw, (cx, y0 + int(20 * scale)), "SYNTROPIC // QUOTE LEAKAGE AUDIT",
            eyebrow_font, fill=_Tokens.ASH, tracking=max(1, int(2 * scale)),
        )

        # Headline figure — the estimated annual net margin leakage.
        figure = f"${estimate.annual_net_margin_leakage / 1e6:.2f}M"
        draw.text((cx, y0 + int(44 * scale)), figure, font=figure_font, fill=_Tokens.INK)

        # Caption.
        draw.text(
            (cx, y0 + int(96 * scale)), "estimated annual net margin leakage",
            font=caption_font, fill=_Tokens.SLATE,
        )

        # Minimal gauge — mist track, ink fill, no chroma, no gridlines.
        track_y = y0 + int(126 * scale)
        track_h = max(3, int(6 * scale))
        track_w = card_w - 2 * pad
        draw.rounded_rectangle(
            [cx, track_y, cx + track_w, track_y + track_h],
            radius=track_h // 2, fill=_Tokens.MIST,
        )
        revenue_share = estimate.annual_net_margin_leakage / max(estimate.revenue_basis_usd, 1.0)
        fill_frac = max(0.06, min(1.0, revenue_share / 0.035))  # gauge saturates at 3.5% of revenue
        draw.rounded_rectangle(
            [cx, track_y, cx + int(track_w * fill_frac), track_y + track_h],
            radius=track_h // 2, fill=_Tokens.INK,
        )

        # Meta rows — the defensive math, in smoke gray.
        vertical_label = _VERTICAL_LABELS.get((vertical or "").lower(), "Industrial Distribution")
        draw.text(
            (cx, track_y + int(16 * scale)),
            f"≈ {revenue_share:.1%} of estimated revenue · {vertical_label}",
            font=meta_font, fill=_Tokens.SMOKE,
        )
        draw.text(
            (cx, track_y + int(34 * scale)),
            f"{estimate.monthly_rfq_volume} RFQs/mo · "
            f"{estimate.avg_quote_delay_hours:.0f}h avg quote turnaround",
            font=meta_font, fill=_Tokens.SMOKE,
        )

        # Footer — attribution + audit deep link.
        domain_label = (domain or "syntropic-os.com").lower()
        draw.text(
            (cx, y0 + card_h - int(30 * scale)),
            f"{company_name} · {domain_label}/audit",
            font=footer_font, fill=_Tokens.ASH,
        )

        composed = Image.alpha_composite(base, layer)
        out = io.BytesIO()
        composed.save(out, "PNG", optimize=True)
        log.info(
            "audit_widget_composed",
            company=company_name,
            figure=figure,
            revenue_share=round(revenue_share, 5),
            out_size=f"{composed.width}x{composed.height}",
        )
        return out.getvalue()


# --------------------------------------------------------------------------- #
# Asset storage — S3/R2 or local mounted dir
# --------------------------------------------------------------------------- #


class AssetStorage:
    """Persists audit PNGs and returns their public CDN URL."""

    def __init__(self, settings: AuditPreviewSettings | None = None) -> None:
        self._settings = settings or get_settings().audit_preview
        self._s3: Any | None = None

    def _s3_client(self) -> Any:
        if self._s3 is None:
            import boto3  # lazy heavy import

            secret = self._settings.aws_secret_access_key
            self._s3 = boto3.client(
                "s3",
                region_name=self._settings.s3_region,
                endpoint_url=self._settings.s3_endpoint_url,
                aws_access_key_id=self._settings.aws_access_key_id,
                aws_secret_access_key=secret.get_secret_value() if secret else None,
            )
        return self._s3

    async def put_png(self, *, key: str, data: bytes) -> str:
        backend = self._settings.storage_backend.lower()
        if backend == "s3":
            return await self._put_s3(key, data)
        return await self._put_local(key, data)

    async def _put_s3(self, key: str, data: bytes) -> str:
        bucket = self._settings.s3_bucket
        if not bucket:
            raise AuditPreviewError("audit_preview.s3_bucket is required for the s3 backend")

        def _upload() -> None:
            self._s3_client().put_object(
                Bucket=bucket,
                Key=key,
                Body=data,
                ContentType="image/png",
                CacheControl="public, max-age=31536000, immutable",
            )

        try:
            await asyncio.to_thread(_upload)
        except Exception as exc:  # noqa: BLE001 - surfaced as AuditPreviewError
            raise AuditPreviewError(f"s3 upload failed for {key}: {exc}") from exc
        url = f"{self._settings.asset_public_base_url}/{key}"
        log.info("audit_asset_uploaded_s3", key=key, bucket=bucket)
        return url

    async def _put_local(self, key: str, data: bytes) -> str:
        path = Path(self._settings.local_dir) / key

        def _write() -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

        await asyncio.to_thread(_write)
        url = f"{self._settings.asset_public_base_url}/{key}"
        log.info("audit_asset_written_local", key=key, path=str(path))
        return url


# --------------------------------------------------------------------------- #
# Generator facade
# --------------------------------------------------------------------------- #


class AuditPreviewGenerator:
    """End-to-end: prospect row → screenshot → widget → CDN → DB + outbox."""

    RFQ_PATH_CANDIDATES = ("/rfq", "/request-a-quote", "/request-quote", "/quote", "/contact", "/contact-us")

    def __init__(
        self,
        db: Database,
        outbox: OutboxStore,
        *,
        settings: AuditPreviewSettings | None = None,
        scraping: ScrapingSettings | None = None,
        capture: ScreenshotCapture | None = None,
        overlay: AuditWidgetOverlay | None = None,
        storage: AssetStorage | None = None,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._db = db
        self._outbox = outbox
        self._settings = settings or get_settings().audit_preview
        self._scraping = scraping or get_settings().scraping
        self._capture = capture or ScreenshotCapture(self._settings)
        self._overlay = overlay or AuditWidgetOverlay(self._settings)
        self._storage = storage or AssetStorage(self._settings)
        self._http = http or httpx.AsyncClient(
            headers={"User-Agent": self._scraping.user_agent},
            timeout=httpx.Timeout(self._scraping.request_timeout_sec, connect=8.0),
            follow_redirects=True,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------ public API
    async def generate(self, prospect_id: str) -> AuditPreview:
        import json as _json

        row = await self._db.fetchrow(
            """
            SELECT id, name, domain, vertical, revenue_estimate_usd
              FROM prospects WHERE id = $1
            """,
            uuid_mod.UUID(prospect_id),
        )
        if row is None:
            raise AuditPreviewError("prospect not found", context={"prospect_id": prospect_id})
        if not row["domain"]:
            raise AuditPreviewError("prospect has no domain to capture", context={"prospect_id": prospect_id})

        target_url = await self._resolve_capture_url(str(row["domain"]))
        shot = await self._capture.capture(target_url)
        estimate = build_leakage_estimate(
            vertical=str(row["vertical"]) if row["vertical"] else None,
            revenue_estimate_usd=row["revenue_estimate_usd"],
        )
        composed = self._overlay.apply(
            shot.png,
            company_name=str(row["name"]),
            domain=str(row["domain"]),
            vertical=str(row["vertical"]) if row["vertical"] else None,
            estimate=estimate,
            width=shot.width,
            height=shot.height,
        )
        key = f"audit-previews/{row['id']}/{uuid_mod.uuid4().hex}.png"
        public_url = await self._storage.put_png(key=key, data=composed)

        preview = AuditPreview(
            prospect_id=str(row["id"]),
            source_url=target_url,
            asset_key=key,
            audit_image_url=public_url,
            width=shot.width,
            height=shot.height,
            leakage=estimate,
        )
        await self._persist(
            preview,
            composed_payload=_json.dumps(preview.model_dump(mode="json"), default=str),
        )
        return preview

    async def generate_batch(self, *, limit: int = 20) -> list[str]:
        """Highest-scoring prospects without an audit image, bounded batch."""
        rows = await self._db.fetch(
            """
            SELECT p.id FROM prospects p
            LEFT JOIN LATERAL (
                SELECT qlv_score FROM scores s
                 WHERE s.prospect_id = p.id ORDER BY scored_at DESC LIMIT 1
            ) latest ON TRUE
             WHERE p.domain IS NOT NULL
               AND p.audit_image_url IS NULL
               AND p.ingestion <> 'filtered'
             ORDER BY COALESCE(latest.qlv_score, 0) DESC, p.created_at
             LIMIT $1
            """,
            limit,
        )
        done: list[str] = []
        for row in rows:
            try:
                preview = await self.generate(str(row["id"]))
                done.append(preview.prospect_id)
            except Exception as exc:  # noqa: BLE001 - batch must survive failures
                log.warning("audit_preview_batch_item_failed", prospect_id=str(row["id"]), error=str(exc))
        return done

    # -------------------------------------------------------------- internals
    async def _resolve_capture_url(self, domain: str) -> str:
        """Prefer the live RFQ page; fall back to the site root."""
        base = f"https://{domain}"
        for path in self.RFQ_PATH_CANDIDATES:
            url = f"{base}{path}"
            try:
                response = await self._http.get(url)
            except httpx.HTTPError as exc:
                log.debug("audit_rfq_probe_failed", url=url, error=str(exc))
                continue
            if response.status_code == 200 and "html" in response.headers.get("content-type", ""):
                return str(response.url)
        log.info("audit_capture_fallback_homepage", domain=domain)
        return base

    async def _persist(self, preview: AuditPreview, *, composed_payload: str) -> None:
        async with self._db.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE prospects
                       SET audit_image_url = $2, updated_at = now()
                     WHERE id = $1
                    """,
                    uuid_mod.UUID(preview.prospect_id),
                    preview.audit_image_url,
                )
                await self._outbox.enqueue(
                    conn,
                    aggregate_type="prospect",
                    aggregate_id=preview.prospect_id,
                    event_type="audit.preview_generated",
                    payload={
                        "audit_image_url": preview.audit_image_url,
                        "asset_key": preview.asset_key,
                        "source_url": preview.source_url,
                        "annual_net_margin_leakage": preview.leakage.annual_net_margin_leakage,
                        "methodology": preview.leakage.methodology,
                    },
                )
        log.info(
            "audit_preview_generated",
            prospect_id=preview.prospect_id,
            url=preview.audit_image_url,
        )


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
    generator = AuditPreviewGenerator(db, outbox)
    try:
        if args.batch:
            done = await generator.generate_batch(limit=args.limit)
            print({"generated": len(done), "prospect_ids": done})
        else:
            if not args.prospect_id:
                raise AuditPreviewError("either --prospect-id or --batch is required")
            preview = await generator.generate(args.prospect_id)
            print(json.dumps(preview.model_dump(mode="json"), indent=2, default=str))
    finally:
        await generator.aclose()
        await db.close()
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="Module 6 — audit preview generator")
    parser.add_argument("--prospect-id", help="Generate an audit preview for one prospect")
    parser.add_argument("--batch", action="store_true", help="Generate for the top unscreenshotted prospects")
    parser.add_argument("--limit", type=int, default=20, help="Batch size")
    sys.exit(asyncio.run(_run(parser.parse_args())))
