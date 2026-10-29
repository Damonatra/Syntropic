#!/usr/bin/env python3
"""Render a visual sample of the Module 6 audit-preview widget.

The base page is a synthetic neutral catalog mock (greys only) — no real
domain is contacted. Output: download/vertebra-audit-widget-sample.png
"""

from __future__ import annotations

import io
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("VERTEBRA_DATABASE__DSN", "postgresql://u:p@localhost:5432/vertebra?sslmode=disable")
os.environ.setdefault("VERTEBRA_QDRANT__URL", "http://localhost:6333")
os.environ.setdefault("VERTEBRA_ANTHROPIC__API_KEY", "sk-ant-harness-not-a-real-key")
os.environ.setdefault("VERTEBRA_CALENDAR__SERVICE_ACCOUNT_FILE", "/tmp/harness-sa.json")
os.environ.setdefault("VERTEBRA_TELEMETRY__TRACKING_HMAC_SECRET", "harness-secret-0123456789abcdef")

from PIL import Image, ImageDraw, ImageFont

from vertebra.config.settings import AuditPreviewSettings
from vertebra.intelligence.audit_preview import AuditWidgetOverlay, build_leakage_estimate

W, H = 1440, 900

page = Image.new("RGBA", (W, H), (250, 250, 251, 255))  # fog-white canvas
draw = ImageDraw.Draw(page)

# Header band
draw.rectangle([0, 0, W, 96], fill=(255, 255, 255, 255))
draw.line([(0, 96), (W, 96)], fill=(236, 236, 236, 255), width=1)
try:
    font_head = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 26)
    font_nav = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
    font_body = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 16)
except OSError:  # pragma: no cover
    font_head = font_nav = font_body = ImageFont.load_default()

draw.text((64, 32), "ACME INDUSTRIAL SUPPLY", font=font_head, fill=(23, 25, 28, 255))
for i, label in enumerate(["Catalog", "Request a Quote", "Contact"]):
    draw.text((W - 480 + i * 150, 40), label, font=font_nav, fill=(119, 123, 134, 255))

# Product grid (achromatic tiles)
for row in range(2):
    for col in range(3):
        x0, y0 = 64 + col * 440, 160 + row * 300
        draw.rounded_rectangle([x0, y0, x0 + 400, y0 + 240], radius=24, fill=(242, 242, 243, 255))
        draw.rounded_rectangle([x0 + 24, y0 + 24, x0 + 376, y0 + 150], radius=16, fill=(226, 227, 229, 255))
        draw.text((x0 + 24, y0 + 172), "1-1/2\" NPT Ball Valve — Class 300", font=font_body, fill=(23, 25, 28, 255))
        draw.text((x0 + 24, y0 + 200), "SKU AV-150-NPT · Quote required", font=font_nav, fill=(163, 166, 175, 255))

buf = io.BytesIO()
page.save(buf, "PNG")

overlay = AuditWidgetOverlay(AuditPreviewSettings(viewport_width=W, viewport_height=H, device_scale_factor=2))
estimate = build_leakage_estimate(vertical="pvf", revenue_estimate_usd=42_000_000)
out = overlay.apply(
    buf.getvalue(),
    company_name="Acme Industrial Supply",
    domain="acme-industrial.example",
    vertical="pvf",
    estimate=estimate,
    width=W,
    height=H,
)

dest = ROOT / "download" / "vertebra-audit-widget-sample.png"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_bytes(out)
print(f"sample written: {dest}  (${estimate.annual_net_margin_leakage:,.0f}/yr)")
