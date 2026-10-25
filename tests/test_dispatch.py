"""Layer 4 Vector 1: zero-UI MS Graph Outlook draft dispatch.

Covers the four Vector 1 criteria end-to-end:
- OAuth 2.0 token caching + silent renewal (no user interaction)
- Draft composition fidelity (effective post-defense pricing, escaped
  HTML, exact recipients, terms) and Drafts-folder-only injection
- 90-second SLA telemetry (sla_ms + sla_breached)
- Human-in-the-loop safeguard: DRAFT-ONLY contract test (source scan +
  functional URL capture) — no code path may ever send mail
- Backbone escalation for unrecoverable failures (missing recipient,
  unreachable mailbox, malformed draft, attempts exhausted)
"""

import asyncio
import re
import time
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from syntropic.core.dispatch import draft_composer, outlook_dispatch
from syntropic.core.dispatch.draft_composer import (
    DraftCompositionError,
    compose_quote_draft,
    extract_recipient_email,
)
from syntropic.core.dispatch.graph_auth import DispatchAuthError, GraphTokenManager
from syntropic.core.dispatch.outlook_dispatch import (
    DispatchConfig,
    dispatch_enabled,
    draft_creation_endpoint,
    get_dispatch_config,
    inject_draft_once,
)
from syntropic.core.matching.api.database import (
    Base,
    DispatchOutbox,
    ReviewJob,
    save_review_job,
)

GRAPH_CONFIG = DispatchConfig(
    tenant_id="contoso.onmicrosoft.com",
    client_id="client-id",
    client_secret="client-secret",
    mailbox_id="estimator@contoso.com",
    sla_seconds=90,
)

# pytest-asyncio runs in STRICT mode (root pyproject.toml): coroutine tests
# carry explicit markers, matching the convention in tests/test_tenant_admin.py.

TOKEN_URL = "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token"
DRAFT_URL = "https://graph.microsoft.com/v1.0/users/estimator@contoso.com/mailFolders/Drafts/messages"


@pytest.fixture
def session_factory(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/dispatch.sqlite3")

    async def create_schema():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(create_schema())
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    asyncio.run(engine.dispose())


# ---------------------------------------------------------------- helpers


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


def _token_manager(captured, graph_responses=None, **kwargs):
    client = httpx.AsyncClient(
        transport=_graph_transport(captured, graph_responses or [])
    )
    return GraphTokenManager(
        "contoso.onmicrosoft.com",
        "client-id",
        "client-secret",
        client=client,
        **kwargs,
    )


def _dispatch_client(captured, graph_responses):
    return httpx.AsyncClient(
        transport=_graph_transport(captured, graph_responses)
    )


def _sample_payload(**overrides):
    payload = {
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
            },
            {
                "part_number": "PIPE-SS-100",
                "description": "1 IN STAINLESS PIPE <script>alert(1)</script>",
                "quantity": 4,
                "unit_of_measure": "FT",
                "unit_price": 88.0,
            },
        ],
        "price_deltas": [
            {
                "line_index": 0,
                "part_number": "VALVE-SS-050",
                "quoted_price": 45.0,
                "pushed_price": 45.0,
                "unit_cost": 28.0,
                "price_floor": 33.6,
                "repriced": False,
            },
            {
                "line_index": 1,
                "part_number": "PIPE-SS-100",
                "quoted_price": 80.0,
                "pushed_price": 88.0,
                "unit_cost": 77.0,
                "price_floor": 88.0,
                "repriced": True,
            },
        ],
        "margin_report": [],
    }
    payload.update(overrides)
    return payload


async def _seed_event(
    session_factory,
    event_id="evt-1",
    job_id="job-1",
    payload=None,
    attempts=0,
    status="pending",
    available_at=None,
):
    async with session_factory() as session:
        async with session.begin():
            session.add(
                ReviewJob(
                    job_id=job_id,
                    tenant_id="acme",
                    filename="rfq.pdf",
                    status="completed",
                    execution_result={},
                )
            )
            session.add(
                DispatchOutbox(
                    event_id=event_id,
                    tenant_id="acme",
                    job_id=job_id,
                    payload=payload or _sample_payload(job_id=job_id),
                    status=status,
                    attempts=attempts,
                    available_at=available_at or datetime(2020, 1, 1),
                )
            )


async def _fetch_event(session_factory, event_id="evt-1"):
    async with session_factory() as session:
        event = await session.get(DispatchOutbox, event_id)
        return {
            "status": event.status,
            "attempts": event.attempts,
            "backbone_reason": event.backbone_reason,
            "sla_ms": event.sla_ms,
            "sla_breached": event.sla_breached,
            "injected_at": event.injected_at,
            "available_at": event.available_at,
            "last_error": event.last_error,
        }


# ---------------------------------------------------- composer (criterion 2)


def test_compose_quote_draft_full_fidelity():
    draft = compose_quote_draft(_sample_payload())
    assert "rfq_acme.pdf" in draft["subject"]
    assert "job-1234" in draft["subject"]
    assert draft["to_recipients"] == [
        {"emailAddress": {"address": "purchasing@acme.com"}}
    ]
    html = draft["html"]
    assert "VALVE-SS-050" in html
    assert "PIPE-SS-100" in html
    assert "$450.00" in html  # 10 x 45.00 effective
    assert "$352.00" in html  # 4 x 88.00 pushed (margin floor)
    assert "$802.00" in html  # total
    assert "NET 45" in html
    assert "repriced automatically to the catalog margin floor" in html
    assert "Original quoted price: $80.00" in html
    assert "click Send" in html  # HITL statement
    assert draft["line_count"] == 2
    assert draft["total_value"] == 802.0


def test_compose_escapes_untrusted_content():
    payload = _sample_payload(
        line_items=[
            {
                "part_number": "PN<&>",
                "description": '" EVIL " <img src=x onerror=steal()>',
                "quantity": 1,
                "unit_of_measure": "EA",
                "unit_price": 10.0,
            }
        ],
        price_deltas=[],
    )
    html = compose_quote_draft(payload)["html"]
    assert "<script" not in html
    assert "<img" not in html
    assert "&lt;img" in html
    assert "PN&lt;&amp;&gt;" in html


def test_compose_missing_recipient_raises():
    with pytest.raises(DraftCompositionError) as excinfo:
        compose_quote_draft(_sample_payload(recipient_email=None))
    assert excinfo.value.reason == "missing_recipient"


def test_extract_recipient_email_sources_and_validation():
    assert (
        extract_recipient_email({"customer_email": " a@b.co "}) == "a@b.co"
    )
    assert extract_recipient_email({"contact_email": "a@b.co"}) == "a@b.co"
    assert extract_recipient_email({"recipient_email": "a@b.co"}) == "a@b.co"
    assert (
        extract_recipient_email({"customer_contact_email": "a@b.co"}) == "a@b.co"
    )
    assert extract_recipient_email({"customer_email": "not-an-address"}) is None
    assert extract_recipient_email({}, None, {}) is None
    # priority: first key wins within a source
    assert (
        extract_recipient_email(
            {"contact_email": "second@b.co", "customer_email": "first@b.co"}
        )
        == "first@b.co"
    )


# ---------------------------------------------- OAuth 2.0 (criterion 1)


@pytest.mark.asyncio
async def test_token_manager_caches_then_silently_refreshes():
    captured = []
    clock = {"now": 1000.0}
    manager = _token_manager(captured, now_fn=lambda: clock["now"])
    try:
        token1 = await manager.get_access_token()
        token2 = await manager.get_access_token()
        assert token1 == token2 == "tok-1"
        assert len(captured) == 1  # cache hit: one HTTP call for two gets
        clock["now"] += 3600  # past expiry minus silent-renewal skew
        await manager.get_access_token()
        assert len(captured) == 2  # silently re-acquired, no user involved
        assert all(str(r.url) == TOKEN_URL for r in captured)
    finally:
        await manager.aclose()


@pytest.mark.asyncio
async def test_token_manager_rejects_malformed_tenant_and_auth_failure():
    with pytest.raises(ValueError):
        GraphTokenManager("bad tenant/../evil", "id", "secret")
    captured = []
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                400, json={"error": "invalid_client"}
            )
        )
    )
    manager = GraphTokenManager(
        "contoso.onmicrosoft.com", "client-id", "wrong-secret", client=client
    )
    with pytest.raises(DispatchAuthError):
        await manager.get_access_token()
    await client.aclose()


# --------------------------------- injection + SLA (criteria 2, 3, 4)


@pytest.mark.asyncio
async def test_inject_draft_success_records_sla(session_factory):
    captured = []
    await _seed_event(session_factory, payload=_sample_payload(job_id="job-1"))
    outcome = await inject_draft_once(
        session_factory,
        GRAPH_CONFIG,
        _token_manager(captured),
        client=_dispatch_client(captured, [httpx.Response(201, json={"id": "d1"})]),
    )
    assert outcome == "injected"
    row = await _fetch_event(session_factory)
    assert row["status"] == "injected"
    assert row["sla_ms"] is not None and row["sla_ms"] < 5000
    assert row["sla_breached"] is False
    assert row["injected_at"] is not None
    # Exactly one Graph write call, into the Drafts folder only.
    graph_calls = [r for r in captured if "oauth2" not in str(r.url)]
    assert len(graph_calls) == 1
    request = graph_calls[0]
    assert str(request.url) == DRAFT_URL
    body = request.read()
    import json as _json

    payload = _json.loads(body)
    assert payload["subject"].startswith("Quote: rfq_acme.pdf")
    assert payload["body"]["contentType"] == "HTML"
    assert payload["toRecipients"] == [
        {"emailAddress": {"address": "purchasing@acme.com"}}
    ]


@pytest.mark.asyncio
async def test_inject_draft_sla_breach_flagged(session_factory):
    captured = []
    stale = datetime.now(timezone.utc) - timedelta(hours=2)
    await _seed_event(
        session_factory, payload=_sample_payload(job_id="job-1", quote_ingested_at=stale.isoformat())
    )
    await inject_draft_once(
        session_factory,
        GRAPH_CONFIG,
        _token_manager(captured),
        client=_dispatch_client(captured, [httpx.Response(201, json={"id": "d1"})]),
    )
    row = await _fetch_event(session_factory)
    assert row["status"] == "injected"
    assert row["sla_ms"] is not None and row["sla_ms"] > 90 * 1000
    assert row["sla_breached"] is True


@pytest.mark.asyncio
async def test_429_honors_retry_after_then_succeeds(session_factory):
    captured = []
    await _seed_event(session_factory)
    responses = [
        httpx.Response(429, headers={"Retry-After": "120"}, json={}),
        httpx.Response(201, json={"id": "d1"}),
    ]
    token_manager = _token_manager(captured)
    before = datetime.now(timezone.utc)
    outcome = await inject_draft_once(
        session_factory,
        GRAPH_CONFIG,
        token_manager,
        client=_dispatch_client(captured, responses),
    )
    assert outcome == "pending"
    row = await _fetch_event(session_factory)
    assert row["status"] == "pending"
    assert row["attempts"] == 1
    assert row["available_at"].replace(tzinfo=timezone.utc) >= before + timedelta(
        seconds=115
    )
    # Simulate the backoff window elapsing, then verify delivery succeeds
    # and no quote was dropped.
    async with session_factory() as session:
        async with session.begin():
            event = await session.get(DispatchOutbox, "evt-1")
            event.available_at = datetime(2020, 1, 1)
    outcome = await inject_draft_once(
        session_factory,
        GRAPH_CONFIG,
        token_manager,
        client=_dispatch_client(captured, responses),
    )
    assert outcome == "injected"
    row = await _fetch_event(session_factory)
    assert row["status"] == "injected"
    assert row["attempts"] == 2


@pytest.mark.asyncio
async def test_404_mailbox_escalates_immediately_to_backbone(session_factory):
    captured = []
    await _seed_event(session_factory)
    outcome = await inject_draft_once(
        session_factory,
        GRAPH_CONFIG,
        _token_manager(captured),
        client=_dispatch_client(captured, [httpx.Response(404, json={})]),
    )
    assert outcome == "backbone"
    row = await _fetch_event(session_factory)
    assert row["status"] == "backbone"
    assert row["backbone_reason"] == "mailbox_unreachable"
    assert row["attempts"] == 1  # no retry churn: escalation is immediate


@pytest.mark.asyncio
async def test_missing_recipient_escalates_without_any_graph_call(session_factory):
    captured = []
    await _seed_event(
        session_factory, payload=_sample_payload(job_id="job-1", recipient_email=None)
    )
    outcome = await inject_draft_once(
        session_factory,
        GRAPH_CONFIG,
        _token_manager(captured),
        client=_dispatch_client(captured, []),
    )
    assert outcome == "backbone"
    row = await _fetch_event(session_factory)
    assert row["status"] == "backbone"
    assert row["backbone_reason"] == "missing_recipient"
    assert captured == []  # composed, never tokenized, never transmitted


@pytest.mark.asyncio
async def test_attempts_exhausted_escalates_to_backbone(session_factory):
    captured = []
    await _seed_event(session_factory, attempts=outlook_dispatch.MAX_DISPATCH_ATTEMPTS - 1)
    outcome = await inject_draft_once(
        session_factory,
        GRAPH_CONFIG,
        _token_manager(captured),
        client=_dispatch_client(captured, [httpx.Response(500, json={})]),
    )
    assert outcome == "backbone"
    row = await _fetch_event(session_factory)
    assert row["status"] == "backbone"
    assert row["backbone_reason"] == "attempts_exhausted"


@pytest.mark.asyncio
async def test_401_invalidates_token_then_succeeds(session_factory):
    captured = []
    token_manager = _token_manager(captured)
    await _seed_event(session_factory)
    responses = [
        httpx.Response(401, json={}),
        httpx.Response(201, json={"id": "d1"}),
    ]
    assert await token_manager.get_access_token() == "tok-1"
    assert len(captured) == 1
    outcome = await inject_draft_once(
        session_factory,
        GRAPH_CONFIG,
        token_manager,
        client=_dispatch_client(captured, responses),
    )
    assert outcome == "pending"
    # Backoff elapsing:
    async with session_factory() as session:
        async with session.begin():
            event = await session.get(DispatchOutbox, "evt-1")
            event.available_at = datetime(2020, 1, 1)
    outcome = await inject_draft_once(
        session_factory,
        GRAPH_CONFIG,
        token_manager,
        client=_dispatch_client(captured, responses),
    )
    assert outcome == "injected"
    token_calls = [r for r in captured if "oauth2" in str(r.url)]
    assert len(token_calls) == 2  # 401 forced a silent re-acquisition


# ------------------------------------------------- enqueue gating (API)


@pytest.mark.asyncio
async def test_enqueue_gated_by_environment(session_factory, monkeypatch):
    execution_result = {
        "webhook_dispatch_requested": True,
        "confidence_score": 0.95,
        "extracted_data": {
            "customer_email": "purchasing@acme.com",
            "payment_terms": "NET 30",
            "line_items": [
                {
                    "part_number": "VALVE-SS-050",
                    "quantity": 10,
                    "unit_of_measure": "EA",
                    "unit_price": 45.0,
                }
            ],
        },
        "price_deltas": [],
        "margin_report": [],
    }
    created = datetime.now(timezone.utc) - timedelta(minutes=3)
    async with session_factory() as session:
        async with session.begin():
            session.add(
                ReviewJob(
                    job_id="job-gate",
                    tenant_id="acme",
                    filename="rfq.pdf",
                    status="flagged_for_review",
                    execution_result={},
                    created_at=created,
                )
            )

    async with session_factory() as session:
        await save_review_job(
            session,
            "job-gate",
            "rfq.pdf",
            "completed",
            execution_result,
            "approve",
            None,
            tenant_id="acme",
        )
    # Disabled by default: ERP outbox enqueued, dispatch outbox NOT.
    async with session_factory() as session:
        rows = (await session.execute(select(DispatchOutbox))).scalars().all()
    assert rows == []

    monkeypatch.setenv("DISPATCH_ENABLED", "true")
    monkeypatch.setenv("GRAPH_TENANT_ID", "contoso.onmicrosoft.com")
    monkeypatch.setenv("GRAPH_CLIENT_ID", "client-id")
    monkeypatch.setenv("GRAPH_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("GRAPH_MAILBOX_ID", "estimator@contoso.com")
    assert dispatch_enabled()

    async with session_factory() as session:
        await save_review_job(
            session,
            "job-gate",
            "rfq.pdf",
            "completed",
            execution_result,
            "approve",
            None,
            tenant_id="acme",
        )
        await save_review_job(  # idempotency: re-approval must not duplicate
            session,
            "job-gate",
            "rfq.pdf",
            "completed",
            execution_result,
            "approve",
            None,
            tenant_id="acme",
        )
    async with session_factory() as session:
        rows = (await session.execute(select(DispatchOutbox))).scalars().all()
    assert len(rows) == 1
    payload = rows[0].payload
    assert payload["event"] == "rfq.draft_requested"
    assert payload["recipient_email"] == "purchasing@acme.com"
    assert payload["line_items"][0]["part_number"] == "VALVE-SS-050"
    assert payload["quote_ingested_at"] is not None


def test_get_dispatch_config_requires_full_surface(monkeypatch):
    monkeypatch.setenv("DISPATCH_ENABLED", "true")
    monkeypatch.setenv("GRAPH_TENANT_ID", "contoso.onmicrosoft.com")
    monkeypatch.setenv("GRAPH_CLIENT_ID", "client-id")
    monkeypatch.setenv("GRAPH_CLIENT_SECRET", "client-secret")
    monkeypatch.delenv("GRAPH_MAILBOX_ID", raising=False)
    assert not dispatch_enabled()
    with pytest.raises(RuntimeError):
        get_dispatch_config()
    monkeypatch.setenv("GRAPH_MAILBOX_ID", "estimator@contoso.com")
    assert dispatch_enabled()
    config = get_dispatch_config()
    assert config.mailbox_id == "estimator@contoso.com"
    assert config.sla_seconds == 90


def test_draft_creation_endpoint_rejects_malformed_mailbox():
    with pytest.raises(RuntimeError):
        draft_creation_endpoint("estimator@contoso.com/../admin")
    with pytest.raises(RuntimeError):
        draft_creation_endpoint("")
    assert (
        draft_creation_endpoint("estimator@contoso.com")
        == "https://graph.microsoft.com/v1.0/users/"
        "estimator@contoso.com/mailFolders/Drafts/messages"
    )


# ------------------------------------- deliver loop + DRAFT-ONLY contract


async def _wait_until(predicate, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if await predicate():
            return True
        await asyncio.sleep(0.02)
    return False


async def _both_injected(session_factory):
    async with session_factory() as session:
        rows = (await session.execute(select(DispatchOutbox))).scalars().all()
        return len(rows) == 2 and all(r.status == "injected" for r in rows)


@pytest.mark.asyncio
async def test_deliver_loop_drains_queue(session_factory):
    captured = []
    responses = [
        httpx.Response(201, json={"id": "d1"}),
        httpx.Response(201, json={"id": "d2"}),
    ]
    await _seed_event(session_factory, event_id="evt-1", job_id="job-1")
    await _seed_event(
        session_factory, event_id="evt-2", job_id="job-2",
        payload=_sample_payload(job_id="job-2"),
    )
    token_manager = _token_manager(captured)
    worker = asyncio.create_task(
        outlook_dispatch.deliver_dispatch_outbox(
            session_factory,
            GRAPH_CONFIG,
            token_manager,
            poll_seconds=0.01,
            client=_dispatch_client(captured, responses),
        )
    )
    try:
        assert await _wait_until(lambda: _both_injected(session_factory))
    finally:
        worker.cancel()
        with suppress(asyncio.CancelledError):
            await worker
    row1 = await _fetch_event(session_factory, "evt-1")
    row2 = await _fetch_event(session_factory, "evt-2")
    assert row1["status"] == "injected"
    assert row2["status"] == "injected"


def test_draft_only_contract_source_scan():
    """No code in the dispatch package may ever contain a send path."""
    package_dir = Path(draft_composer.__file__).parent
    forbidden = re.compile(r"sendMail|send_mail|/send\b|\.send\s*\(", re.IGNORECASE)
    for module_file in package_dir.glob("*.py"):
        source = module_file.read_text(encoding="utf-8")
        assert forbidden.search(source) is None, (
            f"DRAFT-ONLY VIOLATION in {module_file.name}: send path detected."
        )


@pytest.mark.asyncio
async def test_draft_only_contract_functional(session_factory):
    """Every HTTP call in a full inject flow is token or Drafts-folder create."""
    captured = []
    await _seed_event(session_factory)
    await inject_draft_once(
        session_factory,
        GRAPH_CONFIG,
        _token_manager(captured),
        client=_dispatch_client(captured, [httpx.Response(201, json={"id": "d1"})]),
    )
    assert captured, "expected at least one HTTP call"
    for request in captured:
        path = request.url.path
        assert path.endswith("/oauth2/v2.0/token") or path.endswith(
            "/mailFolders/Drafts/messages"
        )
        assert "/send" not in path.lower()

