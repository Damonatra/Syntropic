#!/usr/bin/env python3
"""Vertebra engine verification harness.

Runs the engine's pure-logic surfaces end-to-end WITHOUT any external
service: imports, vertical/region classification, the $10M-$150M corridor
gate, email permutations + syntax hygiene, CASL policy construction, the
degraded-mode rubric scorer, and the Channel A domain rotator caps.

Usage:  python scripts/verify_vertebra.py
"""

from __future__ import annotations

import os
import sys
import tempfile
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


def check(name: str, fn) -> None:
    try:
        detail = fn()
        PASS.append(name)
        print(f"  PASS  {name}" + (f"  — {detail}" if detail else ""))
    except Exception as exc:  # noqa: BLE001
        FAIL.append(name)
        print(f"  FAIL  {name}: {type(exc).__name__}: {exc}")
        traceback.print_exc(limit=3)


def main() -> int:
    print("=" * 72)
    print("VERTEBRA ENGINE VERIFICATION")
    print("=" * 72)

    # -------------------------------------------------------------- imports
    def imports():
        import vertebra.config
        import vertebra.models
        import vertebra.db.pool            # noqa: F401
        import vertebra.db.outbox          # noqa: F401
        import vertebra.ingestion.scraper  # noqa: F401
        import vertebra.ingestion.normalizer  # noqa: F401
        import vertebra.enrichment.permutations  # noqa: F401
        import vertebra.enrichment.casl    # noqa: F401
        import vertebra.enrichment.engine  # noqa: F401
        import vertebra.ai.scorer          # noqa: F401
        import vertebra.ai.hooks           # noqa: F401
        import vertebra.ai.graph           # noqa: F401
        import vertebra.vector.similarity  # noqa: F401
        import vertebra.dispatch.router    # noqa: F401
        import vertebra.dispatch.channel_email  # noqa: F401
        import vertebra.dispatch.high_touch  # noqa: F401
        import vertebra.dispatch.calendar_sync  # noqa: F401
        import vertebra.workers.scheduler  # noqa: F401
        import vertebra.workers.jobs       # noqa: F401
        import vertebra.api.main           # noqa: F401
        return "all 20 engine modules import cleanly"

    check("module-import-graph", imports)

    # ------------------------------------------------------- classification
    def verticals():
        from vertebra.ingestion.normalizer import classify_vertical
        from vertebra.models.domain import Vertical

        assert classify_vertical("Ace Pipe & Valve Supply") is Vertical.PVF
        assert classify_vertical("Great Lakes Hydraulics and Motion Control") is Vertical.FLUID_POWER
        assert classify_vertical("Sunbelt Heating Ventilation Air Conditioning") is Vertical.HVAC
        assert classify_vertical("Ohio Electric Supply Wire & Cable") is Vertical.ELECTRICAL
        assert classify_vertical("Joe's Diner") is None
        assert classify_vertical("PVF and electrical wholesaler") is Vertical.PVF  # priority order
        return "PVF/Fluid Power/HVAC/Electrical + priority order verified"

    check("vertical-classification", verticals)

    def region_casl():
        from vertebra.ingestion.normalizer import detect_region
        from vertebra.models.domain import Region
        from vertebra.enrichment.casl import evaluate_casl_scope

        assert detect_region(state_province="Ontario") is Region.CA
        assert detect_region(state_province="on") is Region.CA
        assert detect_region(state_province="TX") is Region.US
        assert detect_region(postal_code="M5V 2T6") is Region.CA
        assert detect_region(domain="hvacparts.ca") is Region.CA
        assert detect_region(state_province="Ohio") is Region.US

        scope, reason = evaluate_casl_scope(domain="hvacparts.ca", region=None)
        assert scope and reason == "ca_domain"
        scope2, reason2 = evaluate_casl_scope(domain="hvacparts.com", region=Region.US, state_province="Ohio")
        assert not scope2 and reason2 is None
        return "US/CA region inference + CASL scope flags verified"

    check("region-and-casl-scope", region_casl)

    # ------------------------------------------------------------ corridor
    def corridor():
        from vertebra.ingestion.normalizer import corridor_check
        from vertebra.models.domain import CompanyRecord, Vertical

        inside = CompanyRecord(source="t", source_url="https://x", name="Midway Valve",
                               vertical=Vertical.PVF, revenue_estimate_usd=42_000_000)
        below = CompanyRecord(source="t", source_url="https://x", name="Tiny Valves",
                              vertical=Vertical.PVF, revenue_estimate_usd=3_000_000)
        above = CompanyRecord(source="t", source_url="https://x", name="Mega Industrial",
                              vertical=Vertical.PVF, revenue_estimate_usd=900_000_000)
        no_vertical = CompanyRecord(source="t", source_url="https://x", name="Diner Inc",
                                    revenue_estimate_usd=42_000_000)
        assert corridor_check(inside) == (True, None)
        ok_below, why_below = corridor_check(below)
        assert not ok_below and "below_floor" in why_below
        ok_above, why_above = corridor_check(above)
        assert not ok_above and "above_ceiling" in why_above
        ok_vert, why_vert = corridor_check(no_vertical)
        assert not ok_vert and why_vert == "vertical_unmatched"
        return "10M-150M corridor gate verified (accept/below/above/no-vertical)"

    check("revenue-corridor-gate", corridor)

    # -------------------------------------------------------- permutations
    def permutations():
        from vertebra.enrichment.permutations import EmailPermutator, normalise_name, syntax_hygiene
        from vertebra.models.domain import Contact, ExecutiveRole

        name = normalise_name("Maria", "O'Brien")          # apostrophe folding
        assert name.first == "maria" and name.last == "obrien"
        pairs = dict(
            (p, l) for p, l in __import__("vertebra.enrichment.permutations", fromlist=["build_local_parts"]).build_local_parts(name)
        )
        assert pairs["first.last"] == "maria.obrien"
        assert pairs["flast"] == "mobrien"

        contact = Contact(company_name="X", first_name="Dana", last_name="Whitfield", role=ExecutiveRole.COO)
        permutator = EmailPermutator(max_candidates=6)
        candidates = permutator.generate(contact, "WhitfieldSupply.com", casl_scope=False)
        assert candidates[0].address == "dana.whitfield@whitfieldsupply.com"
        assert all(c.syntax_valid for c in candidates)
        assert all(c.domain == "whitfieldsupply.com" for c in candidates)
        assert not syntax_hygiene(".bad", "example.com")[0]
        assert not syntax_hygiene("ok", "bad_domain")[0]
        assert not syntax_hygiene("x" * 65, "example.com")[0]
        return f"permutations rank first.last first; {len(candidates)} hygiene-clean candidates"

    check("email-permutations", permutations)

    # ------------------------------------------------------------- rubric
    def rubric_scorer():
        from vertebra.ai.scorer import RubricScorer, ScoringInput

        hot = ScoringInput(
            prospect_id="11111111-1111-1111-1111-111111111111",
            company_name="Keystone Pipe & Fitting Co",
            vertical="pvf",
            region="us",
            revenue_estimate_usd=55_000_000,
            employee_count=85,
            detected_erp="QuickBooks",
            legacy_portal="customer portal",
            notes="RFQs arrive by fax and email; quotes take two days.",
        )
        result = RubricScorer().score(hot)
        assert 65 <= result.qlv_score <= 100, result.qlv_score
        assert result.band in {"high", "critical"}
        assert len(result.factors) == 6
        assert abs(sum(f.weight for f in result.factors) - 1.0) < 1e-6
        assert result.hooks and all(len(h.body) >= 40 for h in result.hooks)
        assert len(result.input_fingerprint) == 64

        cold = ScoringInput(
            prospect_id="22222222-2222-2222-2222-222222222222",
            company_name="Modern Distribution Corp",
            vertical="electrical",
            region="us",
            revenue_estimate_usd=120_000_000,
            employee_count=220,
            detected_erp="SAP",
        )
        cold_result = RubricScorer().score(cold)
        assert cold_result.qlv_score < result.qlv_score
        return f"hot prospect {result.qlv_score}/100 ({result.band}) > cold prospect {cold_result.qlv_score}/100"

    check("rubric-fallback-scorer", rubric_scorer)

    # ------------------------------------------------------- CASL artifacts
    def casl_artifacts():
        from vertebra.enrichment.casl import build_casl_footer, build_email_headers, unsubscribe_url

        pid = "33333333-3333-3333-3333-333333333333"
        url = unsubscribe_url(pid, "buyer@ontariohvac.ca")
        assert url.startswith("https://syntropic-os.com/u?") and "t=" in url
        footer = build_casl_footer(prospect_id=pid, address="buyer@ontariohvac.ca", region=None)
        assert "Unsubscribe" in footer and "Syntropic" in footer
        headers = build_email_headers(prospect_id=pid, address="buyer@ontariohvac.ca", casl_scope=True)
        assert headers.get("List-Unsubscribe-Post") == "List-Unsubscribe=One-Click"
        assert "List-Unsubscribe" in headers
        return "signed unsubscribe URL + CASL footer + RFC 8058 one-click headers"

    check("casl-compliance-artifacts", casl_artifacts)

    # ------------------------------------------------------- domain rotator
    def rotator():
        from vertebra.config.settings import EmailDispatchSettings
        from vertebra.dispatch.channel_email import DomainRotator
        from vertebra.models.errors import DispatchError

        settings = EmailDispatchSettings(sending_domains=["a.test", "b.test"],
                                         daily_cap_per_domain=2, hourly_cap_per_domain=2)
        rot = DomainRotator(settings)
        picks = [rot.next_domain() for _ in range(4)]
        assert sorted(picks) == ["a.test", "a.test", "b.test", "b.test"]
        for domain in picks:
            rot.record_send(domain)
        try:
            rot.next_domain()
            raise AssertionError("expected DispatchError on exhausted caps")
        except DispatchError:
            pass
        return "round-robin + daily/hourly caps verified (exhaustion raises)"

    check("channel-a-domain-rotator", rotator)

    # ------------------------------------------------------------ embedding
    def embedding():
        from vertebra.vector.similarity import firmographic_vector

        v1 = firmographic_vector(vertical="pvf", region="us", revenue_estimate_usd=48_000_000,
                                 employee_count=80, detected_erp="QuickBooks", city="Houston",
                                 state_province="TX")
        v2 = firmographic_vector(vertical="pvf", region="us", revenue_estimate_usd=52_000_000,
                                 employee_count=85, detected_erp="QuickBooks", city="Dallas",
                                 state_province="TX")
        v3 = firmographic_vector(vertical="electrical", region="ca", revenue_estimate_usd=140_000_000,
                                 employee_count=400, detected_erp="SAP", city="Toronto",
                                 state_province="ON")
        dot = sum(a * b for a, b in zip(v1, v2))
        cross = sum(a * b for a, b in zip(v1, v3))
        assert len(v1) == 64 and abs(sum(x * x for x in v1) - 1.0) < 1e-3
        assert dot > cross, (dot, cross)
        # Determinism
        v1b = firmographic_vector(vertical="pvf", region="us", revenue_estimate_usd=48_000_000,
                                  employee_count=80, detected_erp="QuickBooks", city="Houston",
                                  state_province="TX")
        assert v1 == v1b
        return f"64-dim deterministic L2-normalised embedding; peer-sim {dot:.3f} > cross-sim {cross:.3f}"

    check("firmographic-embedding", embedding)

    # ------------------------------------------------------------ settings
    def settings_roundtrip():
        from vertebra.config.settings import get_settings

        s = get_settings()
        assert s.email.sending_domains == ["syntropic-os.com"]  # default pool
        assert s.policy.channel_a_min_score == 70
        assert s.casl.unsubscribe_sla_days == 10
        return "Pydantic v2 settings graph loads with nested env parsing"

    check("settings-roundtrip", settings_roundtrip)

    # ------------------------------------------------------- outbox models
    def outbox_models():
        from vertebra.models.domain import HighTouchQueueItem, OutboxEvent, utcnow

        event = OutboxEvent(aggregate_type="dispatch", aggregate_id="x", event_type="t",
                            payload={"a": 1})
        assert event.created_at.tzinfo is not None
        item = HighTouchQueueItem(
            prospect_id="44444444-4444-4444-4444-444444444444", company_name="C",
            contact_first="A", contact_last="B", role="ceo", email="a@b.co",
            region="us", vertical="pvf", qlv_score=88, qlv_band="critical",
            top_hook="hook", rationale="why", created_at=utcnow(),
        )
        assert item.qlv_score == 88
        return "OutboxEvent + HighTouchQueueItem contracts validate"

    check("outbox-queue-contracts", outbox_models)

    # ------------------------------------------------------------ exporter
    def exporter_csv():
        import asyncio

        from vertebra.config.settings import get_settings

        async def run():
            class FakePool:
                pass

            # The exporter requires a live DB; here we verify only the CSV
            # writer path via a stub fetch (harness-level integration check).
            from vertebra.db.pool import Database
            from vertebra.db.outbox import OutboxStore
            from vertebra.dispatch.high_touch import HighTouchExporter

            db = Database.__new__(Database)
            db._settings = get_settings().database
            db._pool = None
            db._lock = __import__("asyncio").Lock()

            called = {"pending": False}

            class StubDB:
                async def fetch(self, *_a, **_k):
                    called["pending"] = True
                    from datetime import datetime, timezone
                    return [{
                        "prospect_id": "55555555-5555-5555-5555-555555555555",
                        "company_name": "Harbour Fluid Power", "contact_first": "Liam",
                        "contact_last": "Noonan", "role": "president",
                        "email": "liam.noonan@harbourfp.ca", "phone": None,
                        "city": "Hamilton", "state_province": "ON", "region": "ca",
                        "vertical": "fluid_power", "qlv_score": 91, "qlv_band": "critical",
                        "top_hook": "RFQ latency hook text", "rationale": "r",
                        "detected_erp": "QuickBooks",
                        "calendar_event_id": "evt_123",
                        "created_at": datetime.now(tz=timezone.utc),
                    }]

                async def execute(self, *_a, **_k):
                    return "UPDATE 1"

            exporter = HighTouchExporter.__new__(HighTouchExporter)
            exporter._db = StubDB()
            exporter._outbox = OutboxStore.__new__(OutboxStore)
            with tempfile.TemporaryDirectory() as tmp:
                exporter._export_dir = Path(tmp)
                path = await exporter.export_pending_csv()
                text = path.read_text(encoding="utf-8-sig")
                assert "Harbour Fluid Power" in text and "qlv_score" in text
                return f"CSV export written: {Path(path).name}"

        return asyncio.run(run())

    check("high-touch-csv-export", exporter_csv)

    # ------------------------------------------------------------------ summary
    print("=" * 72)
    print(f"RESULT: {len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        print("Failed checks:", ", ".join(FAIL))
        return 1
    print("ALL ENGINE CHECKS GREEN — Vertebra is structurally sound.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
