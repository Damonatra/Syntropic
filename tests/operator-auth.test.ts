/**
 * Operator auth — the per-operator enclave door.
 *
 * Covers the two halves of the identity contract:
 *   1. operators.ts — scrypt hash/verify (what proves a password)
 *   2. session.ts   — signed operator cookie (what proves a session)
 *
 * The cookie is the identity spine: whatever it verifies is the username
 * that lands in OpsAlertAck.actor and OperatorAction.actor, so the tamper
 * and cross-secret cases here are the trails' integrity cases too.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  hashPassword,
  normalizeUsername,
  verifyPassword,
  OPERATOR_MIN_PASSWORD_LENGTH,
} from "@/lib/vertebra/operators";
import {
  checkSessionCookie,
  gateArmed,
  operatorFromCookie,
  operatorFromRequest,
  sessionCookieFor,
  SESSION_COOKIE,
} from "@/lib/vertebra/session";

const SECRET = "test-session-secret-for-operator-door-0123456789abcdef";

afterEach(() => {
  delete process.env.ENCLAVE_SESSION_SECRET;
});

// --------------------------------------------------------------------------- //
// 1. scrypt credential envelope
// --------------------------------------------------------------------------- //

describe("operator credentials (scrypt)", () => {
  it("round-trips: verify(hash(pw)) is true", async () => {
    const stored = await hashPassword("correct horse battery staple 42");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple 42", stored)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple 42");
    expect(await verifyPassword("correct horse battery staple 43", stored)).toBe(false);
  });

  it("rejects malformed stored envelopes without throwing", async () => {
    await expect(verifyPassword("x", "")).resolves.toBe(false);
    await expect(verifyPassword("x", "plaintext-not-an-envelope")).resolves.toBe(false);
    await expect(verifyPassword("x", "scrypt$notanumber$8$1$abc$def")).resolves.toBe(false);
    await expect(verifyPassword("x", "bcrypt$salt$hash")).resolves.toBe(false);
  });

  it("salts every hash — same password never produces the same envelope", async () => {
    const a = await hashPassword("same-password-both-times-yes");
    const b = await hashPassword("same-password-both-times-yes");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password-both-times-yes", a)).toBe(true);
    expect(await verifyPassword("same-password-both-times-yes", b)).toBe(true);
  });

  it("normalizes handles to lowercase and trims", () => {
    expect(normalizeUsername("  JOSIAS ")).toBe("josias");
    expect(normalizeUsername("Damon")).toBe("damon");
  });

  it("enforces a floor on accepted password length", () => {
    expect(OPERATOR_MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
  });
});

// --------------------------------------------------------------------------- //
// 2. signed operator session
// --------------------------------------------------------------------------- //

describe("operator session cookie", () => {
  it("round-trips: a minted cookie verifies back to the username", async () => {
    process.env.ENCLAVE_SESSION_SECRET = SECRET;
    const value = await sessionCookieFor("josias");
    expect(value).not.toBeNull();
    expect(value?.startsWith("josias.")).toBe(true);
    expect(await operatorFromCookie(value ?? undefined)).toBe("josias");
  });

  it("mints a different signature per username — cookies are not interchangeable", async () => {
    process.env.ENCLAVE_SESSION_SECRET = SECRET;
    const j = await sessionCookieFor("josias");
    const d = await sessionCookieFor("damon");
    expect(j).not.toEqual(d);
    expect(await operatorFromCookie(d ?? undefined)).toBe("damon");
    // damon's cookie must NOT verify as josias — the username is inside the signed message
    expect(j?.replace("josias.", "damon.")).not.toEqual(d);
  });

  it("refuses tampered, truncated, and forged cookies", async () => {
    process.env.ENCLAVE_SESSION_SECRET = SECRET;
    const value = (await sessionCookieFor("josias")) as string;
    const sig = value.slice("josias.".length);
    expect(await operatorFromCookie(`josias.${sig.slice(0, -2)}ff`)).toBeNull();
    expect(await operatorFromCookie("josias")).toBeNull(); // no dot
    expect(await operatorFromCookie(".deadbeef")).toBeNull(); // empty username
    expect(await operatorFromCookie("josias.")).toBeNull(); // empty signature
    // valid signature for josias, wrong name on the front
    expect(await operatorFromCookie(`damon.${sig}`)).toBeNull();
  });

  it("refuses cookies signed under a different secret", async () => {
    process.env.ENCLAVE_SESSION_SECRET = SECRET;
    const value = await sessionCookieFor("josias");
    process.env.ENCLAVE_SESSION_SECRET = `${SECRET}-rotated`;
    expect(await operatorFromCookie(value ?? undefined)).toBeNull();
  });

  it("returns null when the gate is unarmed (no secret, no session)", async () => {
    expect(gateArmed()).toBe(false);
    const value = await sessionCookieFor("josias");
    expect(value).toBeNull();
    expect(await operatorFromCookie("josias.deadbeef")).toBeNull();
  });

  it("middleware posture: valid cookie passes, missing one is bounced, gate-off opens", async () => {
    process.env.ENCLAVE_SESSION_SECRET = SECRET;
    const value = (await sessionCookieFor("damon")) as string;
    expect(await checkSessionCookie(value)).toBe(true);
    expect(await checkSessionCookie(undefined)).toBe(false);
    expect(await checkSessionCookie("damon.tampered")).toBe(false);
    delete process.env.ENCLAVE_SESSION_SECRET;
    expect(await checkSessionCookie(undefined)).toBe(true); // gate off = open
  });

  it("operatorFromRequest reads the identity off a real Cookie header", async () => {
    process.env.ENCLAVE_SESSION_SECRET = SECRET;
    const value = (await sessionCookieFor("josias")) as string;
    const req = new Request("http://enclave.test/api/ops/ack", {
      method: "POST",
      headers: { cookie: `other=1; ${SESSION_COOKIE}=${value}; more=2` },
    });
    expect(await operatorFromRequest(req)).toBe("josias");
    const anon = new Request("http://enclave.test/api/ops/ack", { method: "POST" });
    expect(await operatorFromRequest(anon)).toBeNull();
    const junk = new Request("http://enclave.test/", { headers: { cookie: `${SESSION_COOKIE}=%%%` } });
    expect(await operatorFromRequest(junk)).toBeNull();
  });
});
