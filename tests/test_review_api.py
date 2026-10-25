import asyncio
import base64
import hashlib
import hmac
import json
import sqlite3
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

import syntropic.core.matching.api.main as api
from syntropic.core.matching.api import webhook
from syntropic.core.matching.api.auth import require_authenticated_user
from security.ast_veto import tenant_context


@pytest.fixture
def review_client(tmp_path, monkeypatch):
    database_path = (tmp_path / "review_queue.sqlite3").as_posix()
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{database_path}")
    api.app.state.test_db_path = tmp_path / "review_queue.sqlite3"
    monkeypatch.setattr(api, "UPLOAD_DIR", tmp_path / "uploads")
    api.UPLOAD_DIR.mkdir()
    api.app.state.testing = True
    api.app.dependency_overrides[require_authenticated_user] = lambda: {
        "sub": "test-reviewer"
    }
    with TestClient(api.app) as client:
        yield client
    api.app.dependency_overrides.clear()
    api.app.state.testing = False


def _seed_pending_job(job_id="job-1", execution_result=None):
    if execution_result is None:
        execution_result = {
            "confidence_score": 1.0,
            "extracted_data": {"part_number": "VLV-SS-050", "quantity": 2},
            "matched_catalog_item": {"part_number": "VALVE-SS-050"},
            "catalog_match_score": 0.31,
            "validation_errors": [],
            "execution_log": [
                "Flagged for Human Review: Catalog match score 0.31 below threshold."
            ],
        }
    with sqlite3.connect(api.app.state.test_db_path) as connection:
        connection.execute(
            """INSERT INTO rfq_jobs
               (job_id, tenant_id, filename, status, execution_result)
               VALUES (?, ?, ?, ?, ?)""",
            (
                job_id,
                "test-reviewer",
                "quote.pdf",
                "flagged_for_review",
                json.dumps(execution_result),
            ),
        )


def _add_pending_job(job_id="job-1"):
    _seed_pending_job(job_id)


def _read_job(job_id):
    with sqlite3.connect(api.app.state.test_db_path) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            "SELECT * FROM rfq_jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
    result = dict(row)
    result["execution_result"] = json.loads(result["execution_result"])
    return result


def _read_outbox(job_id):
    with sqlite3.connect(api.app.state.test_db_path) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            "SELECT * FROM webhook_outbox WHERE job_id = ?", (job_id,)
        ).fetchone()
    return dict(row) if row else None


def test_review_routes_require_a_bearer_token(review_client):
    api.app.dependency_overrides.pop(require_authenticated_user)
    response = review_client.get("/api/v1/rfq/reviews")
    api.app.dependency_overrides[require_authenticated_user] = lambda: {
        "sub": "test-reviewer"
    }
    assert response.status_code == 401


def test_authenticated_health_requires_bearer_token_and_returns_identity(
    review_client,
):
    assert review_client.get("/health").status_code == 200
    assert review_client.get("/api/v1/health").status_code == 200
    assert review_client.get("/api/v1/health").json() == {
        "status": "healthy",
        "authenticated_as": "test-reviewer",
    }

    api.app.dependency_overrides.pop(require_authenticated_user)
    try:
        response = review_client.get("/api/v1/health")
    finally:
        api.app.dependency_overrides[require_authenticated_user] = lambda: {
            "sub": "test-reviewer"
        }
    assert response.status_code == 401


def test_tenant_context_is_bound_from_auth_claims_for_the_request(review_client):
    """Regression: bind_tenant_context must bind INSIDE the request context.

    FastAPI executes *sync* generator dependencies in the threadpool, where
    the ContextVar mutation never reaches the handler. If this ever regresses,
    the review queue handler runs tenant-less and the veto gate 403s. Seeding
    a foreign-tenant row proves the queue is scoped to the authenticated
    subject's tenant through the real HTTP stack.
    """
    _seed_pending_job("job-mine")
    with sqlite3.connect(api.app.state.test_db_path) as connection:
        connection.execute(
            """INSERT INTO rfq_jobs
               (job_id, tenant_id, filename, status, execution_result)
               VALUES (?, ?, ?, ?, ?)""",
            ("job-foreign", "acme-corp", "foreign.pdf", "flagged_for_review", "{}"),
        )

    response = review_client.get("/api/v1/rfq/reviews")

    assert response.status_code == 200
    assert response.json() == [{"job_id": "job-mine", "filename": "quote.pdf"}]


def test_next_workstation_origin_is_allowed_by_cors(review_client):
    response = review_client.options(
        "/api/v1/rfq/process",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def _configure_oidc_login(monkeypatch):
    monkeypatch.setenv("OIDC_ISSUER", "https://issuer.example.test/")
    monkeypatch.setenv("OIDC_AUDIENCE", "syntropic-api")
    monkeypatch.setenv("OIDC_JWKS_URL", "https://issuer.example.test/jwks")
    monkeypatch.setenv("OIDC_CLIENT_ID", "syntropic-client")
    monkeypatch.setenv(
        "OIDC_REDIRECT_URI", "http://localhost:8000/api/v1/auth/callback"
    )
    monkeypatch.setenv("OIDC_STATE_SECRET", "unit-test-state-secret-is-at-least-32-bytes")


def test_oidc_authorize_redirect_uses_pkce_and_secure_state_cookie(
    review_client, monkeypatch
):
    _configure_oidc_login(monkeypatch)

    async def oidc_metadata(issuer):
        assert issuer == "https://issuer.example.test/"
        return {
            "issuer": issuer,
            "authorization_endpoint": "https://issuer.example.test/authorize",
            "token_endpoint": "https://issuer.example.test/token",
        }

    monkeypatch.setattr(api, "_oidc_metadata", oidc_metadata)
    response = review_client.get(
        "/api/v1/auth/authorize", follow_redirects=False
    )

    assert response.status_code == 302
    authorization = parse_qs(urlsplit(response.headers["location"]).query)
    assert authorization["client_id"] == ["syntropic-client"]
    assert authorization["redirect_uri"] == [
        "http://localhost:8000/api/v1/auth/callback"
    ]
    assert authorization["code_challenge_method"] == ["S256"]
    flow = api._read_flow_state(
        response.cookies[api.OIDC_FLOW_COOKIE],
        "unit-test-state-secret-is-at-least-32-bytes",
    )
    expected_challenge = base64.urlsafe_b64encode(
        hashlib.sha256(flow["code_verifier"].encode("ascii")).digest()
    ).rstrip(b"=").decode("ascii")
    assert authorization["code_challenge"] == [expected_challenge]
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "samesite=lax" in cookie


def test_oidc_callback_checks_state_and_returns_validated_access_token(
    review_client, monkeypatch
):
    _configure_oidc_login(monkeypatch)
    metadata = {
        "issuer": "https://issuer.example.test/",
        "authorization_endpoint": "https://issuer.example.test/authorize",
        "token_endpoint": "https://issuer.example.test/token",
    }

    async def oidc_metadata(issuer):
        return metadata

    async def exchange_code(code, code_verifier, config, provider_metadata):
        assert code == "authorization-code"
        assert code_verifier
        assert provider_metadata is metadata
        return {
            "access_token": "validated-access-token",
            "id_token": "validated-id-token",
            "expires_in": 300,
        }

    monkeypatch.setattr(api, "_oidc_metadata", oidc_metadata)
    monkeypatch.setattr(api, "exchange_oidc_code", exchange_code)
    monkeypatch.setattr(api, "verify_oidc_id_token", lambda *args: None)
    monkeypatch.setattr(
        api,
        "require_authenticated_user",
        lambda credentials: {"sub": "reviewer-oidc"},
    )

    authorize = review_client.get(
        "/api/v1/auth/authorize", follow_redirects=False
    )
    flow = api._read_flow_state(
        authorize.cookies[api.OIDC_FLOW_COOKIE],
        "unit-test-state-secret-is-at-least-32-bytes",
    )

    mismatch = review_client.get(
        "/api/v1/auth/callback?code=authorization-code&state=wrong"
    )
    assert mismatch.status_code == 401

    response = review_client.get(
        "/api/v1/auth/callback?"
        f"code=authorization-code&state={flow['state']}"
    )
    assert response.status_code == 200
    assert response.json() == {
        "access_token": "validated-access-token",
        "token_type": "bearer",
        "expires_in": 300,
        "authenticated_as": "reviewer-oidc",
    }
    assert response.headers["cache-control"] == "no-store"


def test_oidc_token_endpoint_exchanges_form_encoded_pkce_code(
    review_client, monkeypatch
):
    _configure_oidc_login(monkeypatch)
    metadata = {
        "issuer": "https://issuer.example.test/",
        "authorization_endpoint": "https://issuer.example.test/authorize",
        "token_endpoint": "https://issuer.example.test/token",
    }

    async def oidc_metadata(issuer):
        return metadata

    async def exchange_code(code, code_verifier, config, provider_metadata):
        assert code == "authorization-code"
        assert code_verifier == "a" * 43
        assert provider_metadata is metadata
        return {
            "access_token": "validated-access-token",
            "id_token": "validated-id-token",
            "expires_in": 300,
        }

    monkeypatch.setattr(api, "_oidc_metadata", oidc_metadata)
    monkeypatch.setattr(api, "exchange_oidc_code", exchange_code)
    monkeypatch.setattr(api, "verify_oidc_id_token", lambda *args: None)
    monkeypatch.setattr(
        api,
        "require_authenticated_user",
        lambda credentials: {"sub": "reviewer-oidc"},
    )

    response = review_client.post(
        "/api/v1/auth/token",
        data={
            "grant_type": "authorization_code",
            "code": "authorization-code",
            "code_verifier": "a" * 43,
            "nonce": "oidc-nonce",
            "redirect_uri": "http://localhost:8000/api/v1/auth/callback",
        },
    )

    assert response.status_code == 200
    assert response.json()["access_token"] == "validated-access-token"


def test_oidc_token_endpoint_does_not_accept_username_password(
    review_client,
):
    response = review_client.post(
        "/api/v1/auth/token",
        data={
            "username": "admin@syntropic.ai",
            "password": "EnterprisePass123!",
        },
    )
    assert response.status_code == 422


def test_upload_sanitizes_client_filename_and_uses_checkpoint_thread_id(
    review_client, monkeypatch
):
    document_layout = {
        "file_name": "outside.pdf",
        "text_blocks": [],
        "tables": [],
    }

    class Graph:
        async def ainvoke(self, state, config):
            assert config["configurable"]["thread_id"]
            assert config["run_name"] == "rfq-processing"
            assert config["tags"] == ["rfq", "enterprise"]
            assert config["metadata"]["workflow"] == "rfq-processing"
            assert state["document_layout"] == document_layout
            return {**state, "execution_log": ["workflow completed"]}

    api.app.state.graph_app = Graph()
    monkeypatch.setattr(
        api,
        "parse_pdf_document",
        lambda path: (
            "RFQ sample" if path.suffix.lower() == ".pdf" else "",
            document_layout,
        ),
    )
    response = review_client.post(
        "/api/v1/rfq/process",
        files={"file": ("..\\outside.pdf", b"%PDF-1.4 test", "application/pdf")},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["filename"] == "outside.pdf"
    assert (api.UPLOAD_DIR / f"{result['job_id']}_outside.pdf").is_file()


def test_completed_upload_is_queued_for_webhook_delivery(
    review_client, monkeypatch
):
    class Graph:
        async def ainvoke(self, state, config):
            return {
                **state,
                "extracted_data": {
                    "part_number": "PIPE-SS-100",
                    "quantity": 3,
                    "unit_of_measure": "FT",
                },
                "webhook_dispatch_requested": True,
                "execution_log": [
                    "ERP webhook queued for catalog items: PIPE-SS-100."
                ],
            }

    api.app.state.graph_app = Graph()
    monkeypatch.setattr(
        api,
        "parse_pdf_document",
        lambda path: (
            "Private source text",
            {"file_name": path.name, "text_blocks": [], "tables": []},
        ),
    )
    response = review_client.post(
        "/api/v1/rfq/process",
        files={"file": ("quote.pdf", b"%PDF-1.4 test", "application/pdf")},
    )

    assert response.status_code == 200
    result = response.json()
    event = _read_outbox(result["job_id"])
    assert event is not None
    payload = json.loads(event["payload"])
    assert payload["line_items"] == [
        {
            "part_number": "PIPE-SS-100",
            "quantity": 3,
            "unit_of_measure": "FT",
        }
    ]
    assert "Private source text" not in event["payload"]


def test_reviewer_can_correct_and_approve_a_persisted_job(review_client):
    _add_pending_job()

    queue_response = review_client.get("/api/v1/rfq/reviews")
    assert queue_response.json() == [{"job_id": "job-1", "filename": "quote.pdf"}]

    response = review_client.post(
        "/api/v1/rfq/job-1/review",
        json={
            "decision": "approve",
            "part_number": "VALVE-BR-050",
            "quantity": 4,
            "note": "Corrected against vendor quote.",
        },
    )

    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "completed"
    assert result["review_decision"] == "approve"
    assert result["execution_result"]["extracted_data"] == {
        "part_number": "VALVE-BR-050",
        "quantity": 4,
        "unit_of_measure": "EA",
    }
    assert result["execution_result"]["matched_catalog_item"] is None
    assert _read_job("job-1")["review_note"] == "Corrected against vendor quote."
    outbox_event = _read_outbox("job-1")
    assert outbox_event is not None
    assert outbox_event["status"] == "pending"
    assert json.loads(outbox_event["payload"])["line_items"] == [
        {
            "part_number": "VALVE-BR-050",
            "quantity": 4,
            "unit_of_measure": "EA",
        }
    ]
    assert "raw_input" not in json.loads(outbox_event["payload"])
    assert review_client.get("/api/v1/rfq/reviews").json() == []

    duplicate = review_client.post(
        "/api/v1/rfq/job-1/review", json={"decision": "reject"}
    )
    assert duplicate.status_code == 409


def test_reviewer_can_correct_and_approve_multiple_line_items(review_client):
    execution_result = {
        "confidence_score": 1.0,
        "extracted_data": {
            "part_number": "VALVE-SS-050",
            "quantity": 2,
            "line_items": [
                {
                    "part_number": "VALVE-SS-050",
                    "quantity": 2,
                    "unit_of_measure": "EA",
                },
                {
                    "part_number": "PIPE-SS-100",
                    "quantity": 3,
                    "unit_of_measure": "FT",
                },
            ],
        },
        "matched_catalog_item": {"part_number": "VALVE-SS-050"},
        "matched_catalog_items": [
            {
                "catalog_item": {"part_number": "VALVE-SS-050"},
                "rrf_score": 1.0,
            },
            {"catalog_item": {"part_number": "PIPE-SS-100"}, "rrf_score": 1.0},
        ],
        "catalog_match_score": 1.0,
        "validation_errors": [],
        "execution_log": ["Flagged for Human Review: Manual verification required."],
    }
    _seed_pending_job("job-multi", execution_result)

    response = review_client.post(
        "/api/v1/rfq/job-multi/review",
        json={
            "decision": "approve",
            "line_items": [
                {"part_number": "VALVE-SS-050", "quantity": 4},
                {"part_number": "PIPE-SS-100", "quantity": 3},
            ],
        },
    )

    assert response.status_code == 200
    result = response.json()["execution_result"]
    assert result["extracted_data"]["line_items"] == [
        {
            "part_number": "VALVE-SS-050",
            "quantity": 4,
            "unit_of_measure": "EA",
        },
        {"part_number": "PIPE-SS-100", "quantity": 3, "unit_of_measure": "FT"},
    ]
    assert [
        match["catalog_item"]["part_number"]
        for match in result["matched_catalog_items"]
    ] == ["VALVE-SS-050", "PIPE-SS-100"]
    assert _read_outbox("job-multi") is not None


def test_webhook_outbox_retries_and_permanently_fails_after_eight_attempts(
    review_client,
):
    _add_pending_job("job-webhook")
    response = review_client.post(
        "/api/v1/rfq/job-webhook/review",
        json={"decision": "approve"},
    )
    assert response.status_code == 200
    outbox_event = _read_outbox("job-webhook")
    assert outbox_event is not None
    event_id = outbox_event["event_id"]

    claimed = asyncio.run(webhook._claim_event(api.app.state.session_factory))
    assert claimed is not None
    assert claimed[0] == event_id
    assert claimed[2] == 1
    asyncio.run(
        webhook._mark_failed(
            api.app.state.session_factory,
            event_id,
            claimed[2],
            "webhook endpoint returned HTTP 503",
        )
    )
    retry = _read_outbox("job-webhook")
    assert retry["status"] == "pending"
    assert retry["attempts"] == 1
    assert retry["last_error"] == "webhook endpoint returned HTTP 503"

    with sqlite3.connect(api.app.state.test_db_path) as connection:
        connection.execute(
            "UPDATE webhook_outbox SET attempts = 8 WHERE event_id = ?",
            (event_id,),
        )
    asyncio.run(
        webhook._mark_failed(
            api.app.state.session_factory,
            event_id,
            webhook.MAX_DELIVERY_ATTEMPTS,
            "webhook endpoint returned HTTP 503",
        )
    )
    assert _read_outbox("job-webhook")["status"] == "failed"


def test_webhook_worker_posts_hmac_signed_payload_and_marks_delivered(
    review_client, monkeypatch
):
    _add_pending_job("job-webhook-send")
    response = review_client.post(
        "/api/v1/rfq/job-webhook-send/review",
        json={"decision": "approve"},
    )
    assert response.status_code == 200
    event = _read_outbox("job-webhook-send")
    assert event is not None
    captured_request = {}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, endpoint, *, content, headers):
            captured_request.update(
                {"endpoint": endpoint, "content": content, "headers": headers}
            )
            return type("Response", (), {"is_success": True, "status_code": 204})()

    monkeypatch.setattr(webhook.httpx, "AsyncClient", lambda **kwargs: FakeClient())
    secret = "independent-webhook-secret-with-32-bytes"

    async def deliver_once():
        worker = asyncio.create_task(
            webhook.deliver_webhook_outbox(
                api.app.state.session_factory,
                "https://erp.example.test/webhook",
                secret,
            )
        )
        for _ in range(40):
            await asyncio.sleep(0.05)
            with sqlite3.connect(api.app.state.test_db_path) as connection:
                status_row = connection.execute(
                    "SELECT status FROM webhook_outbox WHERE event_id = ?",
                    (event["event_id"],),
                ).fetchone()
            if status_row and status_row[0] == "delivered":
                break
        else:
            worker.cancel()
            try:
                await worker
            except asyncio.CancelledError:
                pass
            raise AssertionError("Webhook worker did not deliver the queued event.")
        worker.cancel()
        try:
            await worker
        except asyncio.CancelledError:
            pass

    asyncio.run(deliver_once())
    assert captured_request["endpoint"] == "https://erp.example.test/webhook"
    assert captured_request["headers"]["X-Syntropic-Event-ID"] == event["event_id"]
    expected_signature = hmac.new(
        secret.encode(), captured_request["content"], hashlib.sha256
    ).hexdigest()
    assert captured_request["headers"]["X-Syntropic-Signature"] == (
        f"sha256={expected_signature}"
    )
    assert _read_outbox("job-webhook-send")["status"] == "delivered"


def test_webhook_signature_is_hmac_sha256_over_canonical_json():
    payload = {"event": "rfq.approved", "job_id": "job-1"}
    secret = "independent-webhook-secret-with-32-bytes"

    body, signature = webhook.sign_webhook_payload(payload, secret)

    assert json.loads(body) == payload
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert signature == f"sha256={expected}"


def test_review_document_is_available_only_for_a_persisted_job(
    review_client,
):
    _add_pending_job("job-document")
    source_pdf = api.UPLOAD_DIR / "job-document_quote.pdf"
    source_pdf.write_bytes(b"%PDF-1.4 source")

    response = review_client.get(
        "/api/v1/rfq/reviews/job-document/document"
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content == b"%PDF-1.4 source"
    assert review_client.get(
        "/api/v1/rfq/reviews/unknown/document"
    ).status_code == 404


def test_reviewer_can_reject_a_job(review_client):
    _add_pending_job("job-2")

    response = review_client.post(
        "/api/v1/rfq/job-2/review",
        json={"decision": "reject", "note": "Duplicate request."},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "rejected"
    assert "Duplicate request." in response.json()["execution_result"]["execution_log"][-1]
    assert _read_job("job-2")["review_decision"] == "reject"
    assert _read_outbox("job-2") is None


def test_review_queue_event_stream_emits_initial_and_updated_snapshots(
    review_client, monkeypatch
):
    class ConnectedRequest:
        async def is_disconnected(self):
            return False

    async def no_wait(seconds):
        assert seconds == 1
        return None

    monkeypatch.setattr(asyncio, "sleep", no_wait)

    async def read_events():
        # The stream generator is invoked directly here, bypassing the FastAPI
        # dependency that would normally bind the tenant at handshake time.
        with tenant_context("test-reviewer"):
            events = api._review_queue_event_stream(
                ConnectedRequest(), api.app.state.session_factory
            )
            initial_event = await anext(events)
            _seed_pending_job("streamed-job")
            updated_event = await anext(events)
            await events.aclose()
        return initial_event, updated_event

    initial_event, updated_event = review_client.portal.call(read_events)

    assert initial_event["event"] == "review_queue"
    assert json.loads(initial_event["data"]) == {"reviews": []}
    assert updated_event["event"] == "review_queue"
    assert json.loads(updated_event["data"]) == {
        "reviews": [{"job_id": "streamed-job", "filename": "quote.pdf"}]
    }


def test_approval_requires_valid_part_number_and_quantity(review_client):
    _add_pending_job("job-3")

    response = review_client.post(
        "/api/v1/rfq/job-3/review",
        json={"decision": "approve", "part_number": " ", "quantity": 0},
    )

    assert response.status_code == 422
    assert _read_job("job-3")["status"] == "flagged_for_review"