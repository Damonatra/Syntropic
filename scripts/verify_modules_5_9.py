#!/usr/bin/env python3
"""Vertebra Modules 5-9 verification harness.

Runs the advanced tactical modules' pure-logic surfaces end-to-end WITHOUT
any external service: ERP signature classification, quote-portal inference,
pitch-angle authoring, the deterministic leakage estimator, the achromatic
widget overlay, haversine DBSCAN + seed attach, HMAC tracking tokens,
inbound-reply hygiene, and the full LangGraph reply loop against stub
adapters (Claude, Calendar, DB).

Usage:  python scripts/verify_modules_5_9.py
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# ---------------------------------------------------------------------------
# Harness environment: syntactically valid config so Settings() constructs.
# Nothing here contacts a live service — it only satisfies Pydantic settings.
# ---------------------------------------------------------------------------
os.environ.setdefault("VERTEBRA_DATABASE__DSN", "postgresql://u:p@localhost:5432/vertebra?sslmode=disable")
os.environ.setdefault("VERTEBRA_QDRANT__URL", "http://localhost:6333")
os.environ.setdefault("VERTEBRA_ANTHROPIC__API_KEY", "sk-ant-harness-not-a-real-key")
os.environ.setdefault("VERTEBRA_CALENDAR__SERVICE_ACCOUNT_FILE", "/tmp/harness-sa.json")
os.environ.setdefault("VERTEBRA_TELEMETRY__TRACKING_HMAC_SECRET", "harness-secret-0123456789abcdef")
os.environ.setdefault("VERTEBRA_LOG_LEVEL", "WARNING")
os.environ.setdefault("VERTEBRA_LOG_JSON", "false")

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, fn):
    result = fn()
    if asyncio.iscoroutine(result):
        result = asyncio.run(result)
    PASS.append(name)
    print(f"  PASS  {name}" + (f"  — {result}" if result else ""))


def guard(name: str, fn):
    try:
        check(name, fn)
    except Exception as exc:  # noqa: BLE001
        FAIL.append(name)
        print(f"  FAIL  {name}: {type(exc).__name__}: {exc}")
        traceback.print_exc(limit=3)


# --------------------------------------------------------------------------- #
# Module 5 — ERP profiler logic
# --------------------------------------------------------------------------- #


def module5_classification():
    from vertebra.enrichment.erp_profiler import (
        ERP_SIGNATURES,
        ERPProfiler,
        ERPSignal,
    )

    profiler = ERPProfiler(db=None, outbox=None)  # logic-only instance
    signals = [
        ERPSignal(source="page_body", keyword="Prophet 21", snippet="running Prophet 21 for distribution", weight=1.0),
        ERPSignal(source="job_posting", keyword="Prophet 21", snippet="hiring P21 analyst", weight=1.15),
    ]
    name, family, confidence = profiler._classify_erp(signals, "pvf")
    assert name == "Prophet 21", name
    assert family == "Epicor", family
    assert confidence > 0.4, confidence

    none_name, none_family, none_conf = profiler._classify_erp([], "pvf")
    assert none_name is None and none_family is None and none_conf == 0.0
    return f"{len(ERP_SIGNATURES)} signatures; p21 detected with confidence {confidence:.2f}"


def module5_portal_and_pitch():
    from vertebra.enrichment.erp_profiler import DomainProbe, ERPProfiler, PageFetch
    from vertebra.models.domain import QuotePortalType

    profiler = ERPProfiler(db=None, outbox=None)
    probe = DomainProbe(base_url="https://acmevalve.com")
    probe.pages.append(
        PageFetch(
            url="https://acmevalve.com/rfq", status=200,
            body="<a href='mailto:sales@acmevalve.com?subject=quote'>RFQ</a>",
        )
    )
    probe.mailto_hits.append("mailto:sales@acmevalve.com?subject=quote")

    portal, evidence = profiler._classify_portal(probe)
    assert portal == QuotePortalType.MANUAL_MAILTO, portal
    assert evidence, evidence

    pitch = profiler._pitch_angle("Prophet 21", portal, "pvf")
    assert "P21" in pitch and "SPA" in pitch, pitch
    return f"portal={portal.value}; pitch={pitch[:60]}…"


# --------------------------------------------------------------------------- #
# Module 6 — leakage estimator + widget overlay
# --------------------------------------------------------------------------- #


def module6_leakage_estimate():
    from vertebra.intelligence.audit_preview import build_leakage_estimate

    estimate = build_leakage_estimate(vertical="pvf", revenue_estimate_usd=30_000_000)
    assert estimate.monthly_rfq_volume == 270, estimate.monthly_rfq_volume
    expected = 270 * 12 * 4_200 * 0.27 * 0.18
    assert abs(estimate.annual_net_margin_leakage - expected) < 1.0
    assert "270 RFQs/mo" in estimate.methodology
    return f"${estimate.annual_net_margin_leakage:,.0f}/yr on 270 RFQs/mo"


def module6_widget_overlay():
    from PIL import Image

    from vertebra.config.settings import AuditPreviewSettings
    from vertebra.intelligence.audit_preview import AuditWidgetOverlay, build_leakage_estimate

    # Chromatic base proves the overlay itself is strictly achromatic.
    base = Image.new("RGBA", (1440, 900), (220, 30, 30, 255))
    buf = io.BytesIO()
    base.save(buf, "PNG")

    settings = AuditPreviewSettings(viewport_width=1440, viewport_height=900, device_scale_factor=1)
    overlay = AuditWidgetOverlay(settings)
    estimate = build_leakage_estimate(vertical="hvac", revenue_estimate_usd=60_000_000)
    out_bytes = overlay.apply(
        buf.getvalue(),
        company_name="Acme Valve & Fitting",
        domain="acmevalve.com",
        vertical="hvac",
        estimate=estimate,
        width=1440,
        height=900,
    )
    composed = Image.open(io.BytesIO(out_bytes))
    assert composed.size == (1440, 900), composed.size

    # Card interior samples: x 40..520, y 636..860 (CSS px, scale=1).
    rgb = composed.convert("RGB")
    samples = [(100, 660), (120, 700), (90, 745), (140, 790), (300, 655)]
    for x, y in samples:
        r, g, b = rgb.getpixel((x, y))
        assert max(r, g, b) - min(r, g, b) <= 2, f"chromatic pixel at ({x},{y}): {(r, g, b)}"
    return f"5/5 interior samples achromatic on a red base; output {composed.size}"


# --------------------------------------------------------------------------- #
# Module 7 — haversine DBSCAN + seed attach
# --------------------------------------------------------------------------- #


def module7_dbscan():
    from vertebra.spatial.clustering import _nearest_seed, dbscan_haversine, haversine_m

    d = haversine_m(29.7604, -95.3698, 29.9, -95.2)
    assert 15_000 < d < 30_000, d

    points = [
        (29.7604, -95.3698),  # Houston
        (29.8195, -95.3998),  # Houston NW
        (29.6900, -95.2800),  # Houston SE
        (41.8781, -87.6298),  # Chicago — noise at 80 km eps
    ]
    labels = dbscan_haversine(points, eps_m=80_000, min_points=3)
    assert labels[:3] == [0, 0, 0], labels
    assert labels[3] is None, labels
    again = dbscan_haversine(points, eps_m=80_000, min_points=3)
    assert again == labels, "determinism violated"

    seed = _nearest_seed(29.76, -95.37, max_km=150)
    assert seed is not None and seed[0].seed_id == "gulf-coast-pvf-belt", seed
    return f"cluster of 3 + noise; seed={seed[0].name} @ {seed[1]:.0f} km"


# --------------------------------------------------------------------------- #
# Module 8 — tracking tokens
# --------------------------------------------------------------------------- #


def module8_tokens():
    from vertebra.telemetry.intent_tracker import sign_prospect_token, verify_prospect_token

    secret = "harness-secret-0123456789abcdef"
    pid = "3f6d2a1e-8b4c-4d0e-9a1f-2c3d4e5f6a7b"
    token = sign_prospect_token(pid, secret)
    assert verify_prospect_token(token, secret) == pid
    assert verify_prospect_token(token + "x", secret) is None, "tamper accepted"
    assert verify_prospect_token("no-sig", secret) is None
    assert verify_prospect_token(token, "different-secret") is None, "cross-secret accepted"
    return "sign/verify roundtrip + tamper + cross-secret rejection"


# --------------------------------------------------------------------------- #
# Module 9 — reply hygiene + full LangGraph loop on stubs
# --------------------------------------------------------------------------- #


def module9_hygiene():
    from vertebra.ai.reply_agent import strip_quoted_text

    raw = (
        "Happy to talk — send me a time.\n\n"
        "On Mon, Jan 6, 2026 at 9:14 AM Syntropic wrote:\n"
        "> earlier note about RFQ latency\n"
        "--\n"
        "J. Buyer | VP Ops\n"
    )
    cleaned = strip_quoted_text(raw)
    assert cleaned.startswith("Happy to talk"), cleaned
    assert "wrote:" not in cleaned and "VP Ops" not in cleaned
    return f"cleaned={cleaned!r}"


class _StubTx:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _StubConn:
    async def execute(self, sql, *args):
        return "OK"

    async def fetchrow(self, sql, *args):
        return {"id": "stub"}

    def transaction(self):
        return _StubTx()


class _StubAcquire:
    async def __aenter__(self):
        return _StubConn()

    async def __aexit__(self, *exc):
        return False


class _StubPool:
    def acquire(self):
        return _StubAcquire()


class StubDB:
    """Minimal asyncpg-shaped stub so the graph's finalize node can commit."""

    pool = _StubPool()

    async def execute(self, sql, *args):
        return "OK"

    async def fetchrow(self, sql, *args):
        if "FROM inbound_replies" in sql:
            return {
                "id": "00000000-0000-4000-8000-000000000001",
                "prospect_id": None,
                "from_email": "buyer@acmevalve.com",
                "subject": "Re: RFQ turnaround",
                "body": "What you said about quote latency matches our shop.",
            }
        return {"id": "stub"}


class StubOutbox:
    def __init__(self):
        self.events: list[str] = []

    async def enqueue(self, conn, **kwargs):
        self.events.append(kwargs.get("event_type", "?"))
        return None


class StubClassifier:
    def __init__(self, intent):
        self.intent = intent

    async def classify(self, *, lead_ctx, subject, body):
        import datetime as _dt

        from vertebra.models.domain import ReplyExtraction, ReplyIntent

        extraction = (
            ReplyExtraction(return_date=_dt.datetime(2026, 2, 2, tzinfo=_dt.timezone.utc))
            if self.intent == "out_of_office"
            else ReplyExtraction()
        )
        return ReplyIntent(self.intent), 0.94, f'quoted "{body[:20]}…"', extraction


class StubDrafter:
    async def draft(self, *, lead_ctx, intent, reply_body):
        return "Re: quote automation", (
            "Thanks for the straight answer. Our RFQ audit for distributors your size shows the "
            "gap is turnaround, not price — worth 12 minutes to compare notes?"
        )


class StubCalendar:
    def __init__(self):
        self.calls: list[dict] = []

    async def create_urgent_call_invite(self, **kwargs):
        self.calls.append(kwargs)
        return {"event_id": "evt_stub_123", "html_link": "https://cal.stub/evt_stub_123", "start": "stub"}


async def _graph_loop(intent: str, expect_calendar: bool) -> str:
    from vertebra.ai.reply_agent import ReplyAgent, build_reply_graph
    from vertebra.models.domain import ReplyIntent

    db, outbox, calendar = StubDB(), StubOutbox(), StubCalendar()
    agent = ReplyAgent.__new__(ReplyAgent)  # bypass __init__ (builds its own Claude clients)
    agent._db = db
    agent._outbox = outbox
    agent._calendar = calendar
    agent._graph = build_reply_graph(
        db=db,
        outbox=outbox,
        classifier=StubClassifier(intent),
        drafter=StubDrafter(),
        calendar=calendar,
    )
    decision = await agent.process_reply("00000000-0000-4000-8000-000000000001")
    assert decision.intent == ReplyIntent(intent), decision.intent
    if expect_calendar:
        assert decision.calendar_event_id == "evt_stub_123", decision
        assert AgentActionType_has(decision, "book_urgent_call")
        assert len(calendar.calls) == 1
    elif intent.startswith("objection"):
        assert decision.draft_body, "expected a human-review draft"
        assert decision.review_required
    elif intent == "out_of_office":
        assert decision.rescheduled_to is not None
    assert "reply.classified" in outbox.events, outbox.events
    return f"intent={intent}; actions={[a.value for a in decision.actions]}; outbox={outbox.events}"


def AgentActionType_has(decision, value: str) -> bool:
    return any(a.value == value for a in decision.actions)


def module9_graph_objection():
    return asyncio.run(_graph_loop("objection_erp", expect_calendar=False))


def module9_graph_interested():
    return asyncio.run(_graph_loop("interested", expect_calendar=True))


def module9_graph_ooo():
    return asyncio.run(_graph_loop("out_of_office", expect_calendar=False))


def module9_graph_not_interested():
    return asyncio.run(_graph_loop("not_interested", expect_calendar=False))


# --------------------------------------------------------------------------- #
# Autonomous tactical jobs (Modules 5-9 scheduler wiring)
# --------------------------------------------------------------------------- #


def tactical_jobs_wiring():
    import asyncio

    from vertebra.config.settings import TacticalJobsSettings
    from vertebra.workers.tactical_jobs import (
        AUDIT_PREVIEWS_INTERVAL_SEC,
        ERP_PROFILING_INTERVAL_SEC,
        REPLY_PROCESSING_INTERVAL_SEC,
        SPATIAL_CLUSTERING_INTERVAL_SEC,
        TacticalJobs,
        default_tactical_jobs,
    )

    jobs = default_tactical_jobs(object(), object())  # wiring only — no I/O at build time
    names = [j.name for j in jobs]
    assert names == [
        "erp_profiling", "audit_previews", "spatial_clustering", "reply_processing"
    ], names
    by_name = {job.name: job for job in jobs}
    assert by_name["erp_profiling"].interval_sec == ERP_PROFILING_INTERVAL_SEC == 900.0
    assert by_name["audit_previews"].interval_sec == AUDIT_PREVIEWS_INTERVAL_SEC == 1_800.0
    assert by_name["spatial_clustering"].interval_sec == SPATIAL_CLUSTERING_INTERVAL_SEC == 21_600.0
    assert by_name["reply_processing"].interval_sec == REPLY_PROCESSING_INTERVAL_SEC == 120.0

    # Disabled deployments must no-op cleanly without touching any component.
    tactical = TacticalJobs.__new__(TacticalJobs)  # bypass __init__ (no components)
    tactical._components = {}
    tactical._settings = TacticalJobsSettings(
        erp_profiling_enabled=False,
        audit_previews_enabled=False,
        spatial_clustering_enabled=False,
        reply_processing_enabled=False,
    )
    for coro in (
        tactical.erp_profiling(),
        tactical.audit_previews(),
        tactical.spatial_clustering(),
        tactical.reply_processing(),
    ):
        asyncio.run(coro)
    return "4 tactical jobs wired (900s/1800s/21600s/120s); disabled no-op path verified"


# --------------------------------------------------------------------------- #
# Domain-contract roundtrips
# --------------------------------------------------------------------------- #


def domain_models_roundtrip():
    from vertebra.models.domain import ERPMetadata, LeadCluster, RegionalHook, TelemetryEvent

    metadata = ERPMetadata(detected_erp="Prophet 21", erp_family="Epicor", detection_confidence=0.86)
    payload = metadata.model_dump(mode="json")
    assert ERPMetadata.model_validate(payload).detected_erp == "Prophet 21"

    cluster = LeadCluster(
        cluster_id="3f6d2a1e-8b4c-4d0e-9a1f-2c3d4e5f6a7b",
        cluster_name="Gulf Coast PVF Belt", centroid_lat=29.76, centroid_lng=-95.37,
        radius_m=42_000, density_count=7,
    )
    assert LeadCluster.model_validate(cluster.model_dump(mode="json")).density_count == 7
    TelemetryEvent(session_id="s1", event_type="portal_visit")
    RegionalHook(cluster_id=cluster.cluster_id, cluster_name=cluster.cluster_name, hook_text="x", onboarded_this_month=2)
    return "ERPMetadata / LeadCluster / TelemetryEvent / RegionalHook roundtrips"


def main() -> int:
    print("=" * 72)
    print("VERTEBRA MODULES 5-9 VERIFICATION")
    print("=" * 72)

    guard("M5  ERP signature classification", module5_classification)
    guard("M5  portal inference + pitch angle", module5_portal_and_pitch)
    guard("M6  deterministic leakage estimate", module6_leakage_estimate)
    guard("M6  widget overlay achromatic compliance", module6_widget_overlay)
    guard("M7  haversine DBSCAN + determinism + seed attach", module7_dbscan)
    guard("M8  HMAC tracking tokens", module8_tokens)
    guard("M9  inbound reply hygiene", module9_hygiene)
    guard("M9  LangGraph loop — objection_erp → draft", module9_graph_objection)
    guard("M9  LangGraph loop — interested → urgent call", module9_graph_interested)
    guard("M9  LangGraph loop — out_of_office → reschedule", module9_graph_ooo)
    guard("M9  LangGraph loop — not_interested → suppress", module9_graph_not_interested)
    guard("M5-9 tactical scheduler job wiring", tactical_jobs_wiring)
    guard("     domain model roundtrips", domain_models_roundtrip)

    print("-" * 72)
    print(f"PASS {len(PASS)}   FAIL {len(FAIL)}")
    if FAIL:
        print("failed:", ", ".join(FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
