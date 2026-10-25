import asyncio
from contextlib import suppress
import hashlib
import hmac
import json

from syntropic.core.normalizer import TradeAttributeNormalizer
from syntropic.core.matching.api import webhook


def test_uom_and_dimension_normalization():
    """Validates UoM alias mapping and fractional dimension extraction."""
    assert TradeAttributeNormalizer.normalize_uom("pcs") == "EA"
    assert TradeAttributeNormalizer.normalize_uom("BOXES") == "BX"
    assert TradeAttributeNormalizer.normalize_uom("ft") == "FT"

    clean_desc, specs = TradeAttributeNormalizer.extract_dimensions(
        "1/2 inch stainless ball valve"
    )
    assert clean_desc == "0.5 IN STAINLESS BALL VALVE"
    assert specs["size_in"] == 0.5


def test_hmac_webhook_signature_against_local_http_listener(monkeypatch):
    """Tests HMAC-signed delivery through the webhook outbox worker."""
    secret = "test-secret-key-with-at-least-32-bytes"
    payload = {"job_id": "test_123", "part_number": "VALVE-SS-050"}
    event_id = "test-event-id"
    delivered = None
    delivered_event = asyncio.Event()
    claim_count = 0

    async def run_test():
        nonlocal delivered, claim_count

        async def claim_event(_session_factory):
            nonlocal claim_count
            assert _session_factory is None
            claim_count += 1
            if claim_count == 1:
                return event_id, payload, 1
            return None

        async def mark_delivered(_session_factory, claimed_event_id):
            assert _session_factory is None
            assert claimed_event_id == event_id
            delivered_event.set()

        async def mark_failed(_session_factory, claimed_event_id, _attempts, error):
            assert _session_factory is None
            assert _attempts == 1
            raise AssertionError(
                f"Webhook event {claimed_event_id} failed: {error}"
            )

        async def handle_request(reader, writer):
            nonlocal delivered
            request_line = await reader.readline()
            headers = {}
            while line := await reader.readline():
                if line in {b"\r\n", b"\n"}:
                    break
                name, value = line.decode("latin-1").split(":", maxsplit=1)
                headers[name.lower()] = value.strip()

            body = await reader.readexactly(int(headers["content-length"]))
            delivered = {
                "request_line": request_line.decode("latin-1").strip(),
                "headers": headers,
                "body": body,
            }
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: 21\r\n"
                b"Connection: close\r\n\r\n"
                b'{"status":"received"}'
            )
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        monkeypatch.setattr(webhook, "_claim_event", claim_event)
        monkeypatch.setattr(webhook, "_mark_delivered", mark_delivered)
        monkeypatch.setattr(webhook, "_mark_failed", mark_failed)

        server = await asyncio.start_server(handle_request, "127.0.0.1", 0)
        worker = None
        try:
            address = server.sockets[0].getsockname()
            endpoint = f"http://127.0.0.1:{address[1]}/webhook_receiver"
            worker = asyncio.create_task(
                webhook.deliver_webhook_outbox(
                    session_factory=None, endpoint=endpoint, secret=secret
                )
            )
            await asyncio.wait_for(delivered_event.wait(), timeout=5)
        finally:
            if worker is not None:
                worker.cancel()
                with suppress(asyncio.CancelledError):
                    await worker
            server.close()
            await server.wait_closed()

    asyncio.run(run_test())

    assert delivered is not None
    assert delivered["request_line"].startswith("POST /webhook_receiver ")
    assert delivered["headers"]["x-syntropic-event-id"] == event_id
    assert json.loads(delivered["body"]) == payload
    # Signature covers {timestamp}.{body} (Stripe scheme) and must verify
    # receiver-side within the freshness window.
    from syntropic.core.matching.api.webhook import verify_webhook_signature

    assert verify_webhook_signature(
        delivered["body"],
        delivered["headers"]["x-syntropic-signature"],
        delivered["headers"]["x-syntropic-timestamp"],
        secret,
    )
