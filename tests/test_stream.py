"""Layer 4 Vector 2 — Taelin Memory Stream test suite.

Covers the three Section 2 market-readiness criteria:
* recall latency (tail + range p99 <= 30ms at test scale),
* append-only immutability with tamper-evident hash chaining,
* the PII-safe QLoRA fine-tuning export (allowlist + validator),
plus the four pipeline hooks (rfq_ingested / ocr_extracted emission
gating, margin_adjusted aggregation, draft_injected on dispatch success).
"""

import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from syntropic.core import stream as stream_module
from syntropic.core.stream import taelin as taelin_module
from syntropic.core.matching.api.database import (
    Base,
    DispatchOutbox,
    ReviewJob,
    margin_stream_payload,
    save_review_job,
)
from syntropic.core.dispatch.graph_auth import GraphTokenManager
from syntropic.core.dispatch.outlook_dispatch import (
    DispatchConfig,
    inject_draft_once,
)
from syntropic.core.stream import TaelinStream, emit_event, reset_stream
from syntropic.core.stream.finetune_export import (
    export_qlora,
    scrub_text,
    validate_export,
)

# pytest-asyncio runs in STRICT mode: coroutine tests carry explicit markers.

GRAPH_CONFIG = DispatchConfig(
    tenant_id="contoso.onmicrosoft.com",
    client_id="client-id",
    client_secret="client-secret",
    mailbox_id="estimator@contoso.com",
    sla_seconds=90,
)

TOKEN_URL = "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token"
DRAFT_URL = "https://graph.microsoft.com/v1.0/users/estimator@contoso.com/mailFolders/Drafts/messages"


@pytest.fixture
def session_factory(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/stream.sqlite3")

    async def create_schema():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(create_schema())
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    asyncio.run(engine.dispose())


@pytest.fixture
def stream(tmp_path):
    return TaelinStream(root=tmp_path / "streams", rotate_mb=64)


# ----------------------------------------------------------------- helpers


def _graph_transport(captured, graph_responses):
    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if "oauth2" in str(request.url):
            return httpx.Response(
                200, json={"access_token": "tok-1", "expires_in": 3600}
            )
        if graph_responses:
            return graph_responses.pop(0)
        return httpx.Response(500, json={"error": {"message": "unexpected call"}})

    return httpx.MockTransport(handler)


def _approved_payload():
    return {
        "event": "rfq.draft_requested",
        "job_id": "job-12345678-aaaa-bbbb-cccc-ddddeeeeffff",
        "filename": "rfq_acme.pdf",
        "quote_ingested_at": datetime.now(timezone.utc).isoformat(),
        "recipient_email": "purchasing@acme.com",
        "payment_terms": "NET 45",
        "line_items": [
            {
                "part_number": "VALVE-SS-050",
                "description": "0.5 IN STAINLESS BALL VALVE",
                "quantity": 10,
                "unit_of_measure": "EA",
                "unit_price": 45.0,
            }
        ],
        "price_deltas": [],
        "margin_report": [],
    }


# ------------------------------------------------------- 1. core stream


def test_emit_and_tail_roundtrip(stream):
    first = stream.emit("tenant-a", "rfq_ingested", {"size_bytes": 10}, job_id="j1")
    second = stream.emit("tenant-a", "margin_adjusted", {"decision": "pass"}, job_id="j1")

    assert first["seq"] == 1
    assert first["prev"] == "0" * 64  # genesis
    assert second["seq"] == 2
    assert second["prev"] == first["hash"]

    tail = stream.tail("tenant-a", last_n=10)
    assert [r["seq"] for r in tail] == [1, 2]
    assert tail[0]["payload"] == {"size_bytes": 10}
    assert tail[0]["event"] == "rfq_ingested"


def test_verify_ok_and_tamper_detection(stream, tmp_path):
    for i in range(20):
        stream.emit("tenant-a", "ocr_extracted", {"text_chars": i})

    assert stream.verify("tenant-a") == {
        "events": 20,
        "ok": True,
        "first_bad_seq": None,
        "reason": None,
    }

    # Flip one byte inside event #10's payload — the chain must break there.
    path = tmp_path / "streams" / "tenant-a" / "stream.log"
    raw = path.read_bytes()
    lines = raw.split(b"\n")
    target = lines[9]
    marker = target.find(b'"text_chars":9}') if b'"text_chars":9}' in target else None
    if marker is None:
        position = target.index(b"ocr_extracted")
        mutated = target[:position] + b"X" + target[position + 1 :]
    else:
        mutated = target.replace(b'"text_chars":9}', b'"text_chars":99}', 1)
    lines[9] = mutated
    path.write_bytes(b"\n".join(lines))

    report = stream.verify("tenant-a")
    assert report["ok"] is False
    assert report["first_bad_seq"] == 10
    assert report["reason"]


def test_rotation_preserves_chain_and_recall(tmp_path):
    # rotate_mb minimum is 1 byte ceiling via max(...,1): use 0.000001 MB
    stream = TaelinStream(root=tmp_path / "streams", rotate_mb=0.0004)
    for i in range(12):
        stream.emit("tenant-a", "margin_adjusted", {"n": i})

    tenant_dir = tmp_path / "streams" / "tenant-a"
    rotated = sorted(p.name for p in tenant_dir.glob("stream.log.*"))
    assert rotated, "expected rotation to produce archived segments"
    assert (tenant_dir / "stream.log").exists()

    tail = stream.tail("tenant-a", last_n=5)
    assert [r["seq"] for r in tail] == [8, 9, 10, 11, 12]

    report = stream.verify("tenant-a")
    assert report["ok"] is True and report["events"] == 12

    window = stream.range("tenant-a", from_seq=3, to_seq=6)
    assert [r["seq"] for r in window] == [3, 4, 5, 6]


def test_range_query_filters(stream):
    for i in range(30):
        event = "rfq_ingested" if i % 3 == 0 else "margin_adjusted"
        stream.emit("tenant-a", event, {"i": i})

    window = stream.range("tenant-a", from_seq=5, to_seq=15)
    assert [r["seq"] for r in window] == list(range(5, 16))

    ingested = stream.range("tenant-a", from_seq=1, event="rfq_ingested")
    assert [r["seq"] for r in ingested] == [1, 4, 7, 10, 13, 16, 19, 22, 25, 28]


def test_restart_rebuilds_index_and_continues_chain(tmp_path):
    root = tmp_path / "streams"
    first = TaelinStream(root=root)
    last = None
    for i in range(5):
        last = first.emit("tenant-a", "rfq_ingested", {"i": i})

    second = TaelinStream(root=root)  # cold start: index rebuild from disk
    nxt = second.emit("tenant-a", "rfq_ingested", {"i": 5})
    assert nxt["seq"] == last["seq"] + 1
    assert nxt["prev"] == last["hash"]
    assert second.verify("tenant-a")["ok"] is True
    assert second.stats("tenant-a")["events"] == 6


def test_tenant_validation_rejects_unsafe_ids(stream):
    for bad in ("../evil", "", "a/b", ".hidden", "tenant;rm", None, "x" * 65):
        with pytest.raises(Exception):
            stream.emit(bad, "rfq_ingested", {})


def test_stats_shape(stream):
    for i in range(3):
        stream.emit("tenant-a", "rfq_ingested", {"i": i})
    stats = stream.stats("tenant-a")
    assert stats["events"] == 3
    assert stats["files"] == 1
    assert stats["bytes"] > 0


# --------------------------------------------------- 2. recall SLA (30ms)


def test_recall_latency_at_scale(stream):
    for i in range(100_000):
        stream.emit(
            "tenant-hot",
            "margin_adjusted" if i % 2 else "rfq_ingested",
            {"i": i, "decision": "pass", "line_count": 3},
        )

    # tail(): most recent 50 events, 200 samples
    tail_latencies = []
    for _ in range(200):
        started = time.perf_counter()
        records = stream.tail("tenant-hot", last_n=50)
        tail_latencies.append((time.perf_counter() - started) * 1000)
        assert len(records) == 50
    tail_latencies.sort()
    tail_p99 = tail_latencies[int(0.99 * len(tail_latencies)) - 1]
    assert tail_p99 <= 30.0, f"tail p99 {tail_p99:.2f}ms breaches 30ms SLA"

    # range(): recent 1,000-event window, 100 samples
    range_latencies = []
    for _ in range(100):
        started = time.perf_counter()
        records = stream.range("tenant-hot", from_seq=99_001, to_seq=100_000)
        range_latencies.append((time.perf_counter() - started) * 1000)
        assert len(records) == 1_000
    range_latencies.sort()
    range_p99 = range_latencies[int(0.99 * len(range_latencies)) - 1]
    assert range_p99 <= 30.0, f"range p99 {range_p99:.2f}ms breaches 30ms SLA"


# ------------------------------------------- 3. gating + fault isolation


def test_emit_event_disabled(monkeypatch, tmp_path):
    monkeypatch.setattr(taelin_module.settings, "STREAM_ENABLED", False)
    reset_stream()
    try:
        assert (
            emit_event("rfq_ingested", "tenant-a", {"x": 1}, job_id="j") is None
        )
        assert not (tmp_path / "streams").exists()
    finally:
        reset_stream()


def test_emit_event_missing_tenant(monkeypatch, tmp_path):
    monkeypatch.setattr(taelin_module.settings, "STREAM_ENABLED", True)
    monkeypatch.setattr(taelin_module.settings, "STREAM_ROOT", str(tmp_path / "s"))
    reset_stream()
    try:
        assert emit_event("rfq_ingested", None, {"x": 1}) is None
        assert not (tmp_path / "s").exists()
    finally:
        reset_stream()


def test_emit_event_swallows_io_errors(monkeypatch, tmp_path):
    blocker = tmp_path / "blocker"
    blocker.write_text("a regular file, not a directory")
    monkeypatch.setattr(taelin_module.settings, "STREAM_ENABLED", True)
    monkeypatch.setattr(taelin_module.settings, "STREAM_ROOT", str(blocker))
    reset_stream()
    try:
        # root exists but is a file -> tenant dir creation fails -> swallowed
        assert emit_event("rfq_ingested", "tenant-a", {"x": 1}) is None
    finally:
        reset_stream()


# ---------------------------------------------------- 4. QLoRA export PII


def test_scrub_text_masks_emails():
    scrubbed = scrub_text("Contact purchasing@acme.com or fallback@corp.org")
    assert "acme.com" not in scrubbed and "corp.org" not in scrubbed
    assert scrubbed.count("EMAIL_") == 2


def test_allowlist_drops_pii_and_supplier_costs():
    from syntropic.core.stream.finetune_export import _whiten

    payload = {
        "decision": "reprice",
        "line_count": 3,
        "repriced_count": 1,
        "veto_count": 0,
        "margin_delta": 12.5,
        "sku_ids": ["VALVE-SS-050"],
        # forbidden fields must be dropped by the allowlist:
        "recipient_email": "purchasing@acme.com",
        "customer_name": "Acme Corp",
        "unit_cost": 28.0,
        "supplier_cost_sheet": "confidential.xlsx",
    }
    whitened = _whiten("margin_adjusted", payload)
    assert whitened == {
        "decision": "reprice",
        "line_count": 3,
        "repriced_count": 1,
        "veto_count": 0,
        "margin_delta": 12.5,
        "sku_ids": ["VALVE-SS-050"],
    }


def test_export_builds_valid_samples(tmp_path):
    stream = TaelinStream(root=tmp_path / "streams")
    tenant = "tenant-a"
    stream.emit(tenant, "rfq_ingested", {"size_bytes": 100, "sha256_16": "ab" * 8, "filename_ext": "pdf"})
    stream.emit(tenant, "ocr_extracted", {"text_chars": 1200, "tables": 2, "text_blocks": 14})
    stream.emit(
        tenant,
        "margin_adjusted",
        {
            "decision": "reprice",
            "line_count": 2,
            "repriced_count": 1,
            "veto_count": 0,
            "margin_delta": 8.0,
            "sku_ids": ["VALVE-SS-050"],
        },
    )
    stream.emit(tenant, "draft_injected", {"sla_ms": 41_000, "sla_breached": False, "line_count": 2})
    # unknown event types are skipped by the export entirely
    stream.emit(tenant, "future_event", {"whatever": 1})

    out = tmp_path / "qlora.jsonl"
    summary = export_qlora(tmp_path / "streams", [tenant], out)

    assert summary["ok"] is True
    assert summary["samples"] == 4
    lines = [json.loads(line) for line in out.read_text().splitlines()]
    assert all({"instruction", "input", "output"} == set(row) for row in lines)
    serialized = out.read_text()
    assert "acme" not in serialized and "@" not in serialized
    assert "unit_cost" not in serialized


def test_validate_export_rejects_planted_pii(tmp_path):
    out = tmp_path / "bad.jsonl"
    good = {"instruction": "i", "input": {"line_count": 2}, "output": {"decision": "pass"}}
    bad = {"instruction": "i", "input": {"unit_cost": 28.0}, "output": {}}
    email = {"instruction": "mail purchasing@acme.com", "input": {}, "output": {}}
    out.write_text(
        json.dumps(good) + "\n" + json.dumps(bad) + "\n" + json.dumps(email) + "\n"
    )
    report = validate_export(out)
    assert report["ok"] is False
    assert any("forbidden key" in v for v in report["violations"])
    assert any("email-like PII" in v for v in report["violations"])


# ------------------------------------------------------------ 5. hooks


def test_margin_stream_payload_aggregation():
    execution_result = {
        "margin_report": [
            {"decision": "reprice", "part_number": "VALVE-SS-050"},
            {"decision": "veto", "part_number": "PIPE-SS-100"},
        ],
        "price_deltas": [
            {"quoted_price": 80.0, "pushed_price": 88.0},
            {"quoted_price": 10.0, "pushed_price": 10.5},
        ],
    }
    payload = margin_stream_payload(execution_result)
    assert payload["decision"] == "veto"  # any veto dominates
    assert payload["line_count"] == 2
    assert payload["repriced_count"] == 1
    assert payload["veto_count"] == 1
    assert payload["margin_delta"] == pytest.approx(8.5)

    assert margin_stream_payload({"extracted_data": {}}) is None


@pytest.mark.asyncio
async def test_margin_adjusted_hook_fires_on_save(monkeypatch, tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/review.sqlite3")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(taelin_module.settings, "STREAM_ENABLED", True)
    monkeypatch.setattr(taelin_module.settings, "STREAM_ROOT", str(tmp_path / "streams"))
    reset_stream()

    recorded = []

    def recorder(event, tenant_id, payload, job_id=None):
        recorded.append((event, tenant_id, payload, job_id))
        return {}

    monkeypatch.setattr(
        "syntropic.core.matching.api.database.emit_event", recorder
    )
    try:
        async with factory() as session:
            await save_review_job(
                session,
                "job-hook-1",
                "rfq.pdf",
                "completed",
                {
                    "extracted_data": {},
                    "margin_report": [{"decision": "pass", "part_number": "X-1"}],
                },
                tenant_id="tenant-a",
            )
    finally:
        reset_stream()
        await engine.dispose()

    events = [event for event, *_ in recorded if event == "margin_adjusted"]
    assert events == ["margin_adjusted"]
    margin_event = next(e for e in recorded if e[0] == "margin_adjusted")
    assert margin_event[1] == "tenant-a"
    assert margin_event[2]["decision"] == "pass"


@pytest.mark.asyncio
async def test_draft_injected_stream_event(session_factory, tmp_path, monkeypatch):
    event_id = "ev-stream-1"
    async with session_factory() as session:
        async with session.begin():
            session.add(
                DispatchOutbox(
                    event_id=event_id,
                    tenant_id="tenant-a",
                    job_id="job-12345678-aaaa-bbbb-cccc-ddddeeeeffff",
                    payload=_approved_payload(),
                )
            )

    monkeypatch.setattr(taelin_module.settings, "STREAM_ENABLED", True)
    monkeypatch.setattr(taelin_module.settings, "STREAM_ROOT", str(tmp_path / "streams"))
    reset_stream()

    captured: list[httpx.Request] = []
    graph_responses = [
        httpx.Response(201, json={"id": "draft-1", "@odata.context": "x"}),
    ]
    client = httpx.AsyncClient(transport=_graph_transport(captured, graph_responses))
    token_manager = GraphTokenManager(
        "contoso.onmicrosoft.com", "client-id", "client-secret", client=client
    )

    from syntropic.core.dispatch import outlook_dispatch

    try:
        outcome = await inject_draft_once(
            session_factory, GRAPH_CONFIG, token_manager, client=client
        )
        assert outcome == "injected"

        stream = TaelinStream(root=tmp_path / "streams")
        records = stream.range("tenant-a", from_seq=1, event="draft_injected")
        assert len(records) == 1
        payload = records[0]["payload"]
        assert payload["sla_ms"] is not None and payload["sla_ms"] >= 0
        assert payload["sla_breached"] is False
        assert payload["line_count"] == 1
        assert records[0]["job_id"] == "job-12345678-aaaa-bbbb-cccc-ddddeeeeffff"
    finally:
        reset_stream()
        await client.aclose()


# ---------------------------------------------------- 6. Typesafe AI JEV


def test_typesafe_jev_stream_validation(stream):
    """Typesafe AI JEV validates payloads before appending to the stream."""
    valid_ingested = stream.emit(
        "tenant-jev",
        "rfq_ingested",
        {"filename_ext": "pdf", "size_bytes": 1024, "sha256_16": "0123456789abcdef"},
    )
    assert valid_ingested["payload"]["filename_ext"] == "pdf"

    valid_ocr = stream.emit(
        "tenant-jev",
        "ocr_extracted",
        {"text_chars": 500, "tables": 1, "text_blocks": 10},
    )
    assert valid_ocr["payload"]["text_chars"] == 500

    valid_margin = stream.emit(
        "tenant-jev",
        "margin_adjusted",
        {
            "decision": "reprice",
            "line_count": 2,
            "repriced_count": 1,
            "veto_count": 0,
            "margin_delta": 15.0,
            "sku_ids": ["SKU-1"],
            "margin_delta_by_currency": {"USD": 15.0},
        },
    )
    assert valid_margin["payload"]["decision"] == "reprice"

    # Malformed payload with invalid type/constraint triggers Pydantic ValidationError
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        stream.emit(
            "tenant-jev",
            "rfq_ingested",
            {"size_bytes": -500},  # size_bytes must be >= 0
        )


def test_dispatch_claim_signature_tenant_aware():
    """The claim contract now threads tenant_id into the success path."""
    from syntropic.core.dispatch import outlook_dispatch
    import inspect

    source = inspect.getsource(outlook_dispatch._claim_dispatch)
    assert "event.tenant_id" in source
