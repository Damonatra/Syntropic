/**
 * Webhook door crypto + event translation — the machine doors' integrity
 * cases. The enclave admits machines through two signature schemes; every
 * case here is a way an impostor (or a replay) tries to walk through one.
 *
 *   1. verifySvix      — Resend's scheme: id.timestamp.payload, whsec_ key,
 *                        space-separated v1 candidates, replay tolerance
 *   2. hmacDoorValid   — the enclave's own door contract (portal/heartbeat
 *                        pattern) now shared by the mail relay door
 *   3. parseAddressHeader — the From-line parser every door leans on
 *   4. resolveEventEffect — provider event → ledger vocabulary
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  hmacDoorValid,
  parseAddressHeader,
  SVIX_TIMESTAMP_TOLERANCE_MS,
  verifySvix,
  type SvixHeaders,
} from "@/lib/vertebra/webhook-verify";
import { resolveEventEffect } from "@/lib/vertebra/resend-events";

// --------------------------------------------------------------------------- //
// Svix signing helper — replicates the provider scheme exactly
// --------------------------------------------------------------------------- //

const WHSEC = "whsec_" + Buffer.from("test-svix-signing-secret-0123456789abcdef").toString("base64");
const RAW_SECRET_BYTES = Buffer.from(WHSEC.slice("whsec_".length), "base64");

function signSvix(body: string, id: string, timestampSeconds: number): string {
  const content = `${id}.${timestampSeconds}.${body}`;
  return createHmac("sha256", RAW_SECRET_BYTES).update(content, "utf8").digest("base64");
}

function svixHeaders(id: string, ts: number, sig: string): SvixHeaders {
  return { id, timestamp: String(ts), signature: sig };
}

// --------------------------------------------------------------------------- //
// 1. Svix verification
// --------------------------------------------------------------------------- //

describe("verifySvix (Resend event + receiving webhooks)", () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });
  const now = Math.floor(Date.now() / 1000);
  const id = "msg_test_0001";

  it("accepts a correctly signed webhook and returns the svix-id", () => {
    const sig = signSvix(body, id, now);
    const res = verifySvix(body, svixHeaders(id, now, `v1,${sig}`), WHSEC);
    expect(res).toEqual({ ok: true, eventId: id });
  });

  it("rejects a tampered body — signature no longer covers the payload", () => {
    const sig = signSvix(body, id, now);
    const tampered = body.replace("e1", "e2");
    const res = verifySvix(tampered, svixHeaders(id, now, `v1,${sig}`), WHSEC);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_signature");
  });

  it("rejects a replay past the tolerance window", () => {
    const sig = signSvix(body, id, now);
    const stale = now - Math.ceil(SVIX_TIMESTAMP_TOLERANCE_MS / 1000) - 120;
    const res = verifySvix(body, svixHeaders(id, stale, `v1,${sig}`), WHSEC);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("stale_timestamp");
  });

  it("accepts a signature inside the tolerance window", () => {
    const sig = signSvix(body, id, now - 60);
    const res = verifySvix(body, svixHeaders(id, now - 60, `v1,${sig}`), WHSEC);
    expect(res.ok).toBe(true);
  });

  it("tries every v1 candidate — key rotation delivers space-separated lists", () => {
    const oldSecret = Buffer.from("old-rotation-secret-0000000000000000", "utf8");
    const oldSig = createHmac("sha256", oldSecret).update(`${id}.${now}.${body}`, "utf8").digest("base64");
    const currentSig = signSvix(body, id, now);
    const res = verifySvix(body, svixHeaders(id, now, `v1,${oldSig} v1,${currentSig}`), WHSEC);
    expect(res.ok).toBe(true);
  });

  it("rejects when no candidate matches (wrong secret)", () => {
    const otherWhsec = "whsec_" + Buffer.from("a-completely-different-secret-value").toString("base64");
    const sig = signSvix(body, id, now);
    const res = verifySvix(body, svixHeaders(id, now, `v1,${sig}`), otherWhsec);
    expect(res.ok).toBe(false);
  });

  it("refuses the door entirely when no secret is configured", () => {
    const sig = signSvix(body, id, now);
    const res = verifySvix(body, svixHeaders(id, now, `v1,${sig}`), undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("webhook_secret_not_configured");
  });

  it("rejects missing svix headers", () => {
    const res = verifySvix(body, { id: null, timestamp: String(now), signature: "v1,abc" }, WHSEC);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing_svix_headers");
  });

  it("accepts a bare (non-whsec) secret as raw utf8 — sandbox and test harness", () => {
    const rawSecret = "plain-dev-secret";
    const sig = createHmac("sha256", Buffer.from(rawSecret, "utf8")).update(`${id}.${now}.${body}`, "utf8").digest("base64");
    const res = verifySvix(body, svixHeaders(id, now, `v1,${sig}`), rawSecret);
    expect(res.ok).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
// 2. The enclave door contract (HMAC-SHA256 hex, x-vertebra-signature)
// --------------------------------------------------------------------------- //

describe("hmacDoorValid (canonical relay door)", () => {
  const secret = "inbound-mail-door-secret-0123456789abcdef";
  const body = JSON.stringify({ from: "jane@acme.com", text: "we should talk" });

  it("accepts the correct hex signature", () => {
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(hmacDoorValid(body, sig, secret)).toBe(true);
  });

  it("tolerates the sha256= prefix and case drift", () => {
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(hmacDoorValid(body, `sha256=${sig.toUpperCase()}`, secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(hmacDoorValid(body.replace("talk", "walk"), sig, secret)).toBe(false);
  });

  it("refuses when the secret or the signature is absent", () => {
    expect(hmacDoorValid(body, null, secret)).toBe(false);
    expect(hmacDoorValid(body, "deadbeef", undefined)).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// 3. From-line parsing
// --------------------------------------------------------------------------- //

describe("parseAddressHeader", () => {
  it("extracts address and display name", () => {
    expect(parseAddressHeader('"Damon Vale" <Damon@Acme.com>')).toEqual({ address: "damon@acme.com", name: "Damon Vale" });
  });

  it("handles unquoted display names and bare addresses", () => {
    expect(parseAddressHeader("Josias R <josias@syntropic-os.com>")?.address).toBe("josias@syntropic-os.com");
    expect(parseAddressHeader("desk@syntropic-os.com")).toEqual({ address: "desk@syntropic-os.com", name: null });
  });

  it("refuses anything without a plausible address", () => {
    expect(parseAddressHeader("not-an-address")).toBeNull();
    expect(parseAddressHeader("")).toBeNull();
    expect(parseAddressHeader(null)).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// 4. Event → ledger vocabulary
// --------------------------------------------------------------------------- //

describe("resolveEventEffect", () => {
  it("delivered/opened are pure status escalations — no suppression", () => {
    expect(resolveEventEffect("email.delivered", null)).toMatchObject({ dispatchStatus: "delivered", suppressionReason: null, stopSequences: false });
    expect(resolveEventEffect("email.opened", null)).toMatchObject({ dispatchStatus: "opened", suppressionReason: null, stopSequences: false });
  });

  it("a permanent (hard) bounce suppresses the address and stops the sequences", () => {
    const effect = resolveEventEffect("email.bounced", "Permanent");
    expect(effect).toMatchObject({ dispatchStatus: "failed", suppressionReason: "bounce", stopSequences: true, pulseStatus: "warn" });
  });

  it("a transient bounce fails the dispatch but never suppresses the address", () => {
    const effect = resolveEventEffect("email.bounced", "Transient");
    expect(effect).toMatchObject({ dispatchStatus: "failed", suppressionReason: null, stopSequences: false });
  });

  it("an unknown bounce type is treated as transient — suppression needs proof", () => {
    expect(resolveEventEffect("email.bounced", null)?.suppressionReason).toBeNull();
  });

  it("a spam complaint lands in the suppression ledger like an unsubscribe", () => {
    const effect = resolveEventEffect("email.complained", null);
    expect(effect).toMatchObject({ dispatchStatus: "stopped", suppressionReason: "complaint", stopSequences: true, pulseStatus: "warn" });
  });

  it("sent escalates a queued dispatch only", () => {
    expect(resolveEventEffect("email.sent", null)).toMatchObject({ dispatchStatus: "sent", fromStatuses: ["queued"] });
  });

  it("unknown event types are ignored (the webhook must still 200)", () => {
    expect(resolveEventEffect("email.clicked", null)).toBeNull();
    expect(resolveEventEffect("something.else", null)).toBeNull();
  });
});
