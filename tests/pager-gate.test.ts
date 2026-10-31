/**
 * The pager gate + probe — a configured channel is not an armed channel.
 *
 * The pager obeys the enclave constitution like every other spoke:
 *
 *   1. staged row + key present → refused (integration_not_armed), zero HTTP
 *   2. armed row + key present → fires exactly once to the right URL
 *   3. unregistered channel → refused (integration_unregistered)
 *   4. circuit open → refused (integration_circuit_open); retired too
 *   5. armed row + env var deleted → skipped silently (env presence IS
 *      the pager's key check — the gate never even consults)
 *   6. no env vars → silent skip for both channels, no gate consults
 *   7. probePagerChannel — one real test page to ONE channel, wire-checked
 *   8. probeIntegration pager branch — test_page_fired lands on the row,
 *      a passing probe closes the circuit, a failing one writes lastError
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

vi.hoisted(() => {
  process.env.DATABASE_URL = `file:${process.cwd()}/db/pager-test.db`;
});

import { db } from "@/lib/db";
import { deliverAlert, probePagerChannel } from "@/lib/vertebra/pager";
import { probeIntegration } from "@/lib/vertebra/integrations";

const SCRATCH = join(process.cwd(), "db", "pager-test.db");
const SLACK_HOOK = "https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx";

const fakeFetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" }) as unknown as Response);

async function seedPagerRow(provider: string, keyEnvVar: string) {
  const existing = await db.integrationRecord.findUnique({ where: { provider } });
  if (existing) return existing;
  return db.integrationRecord.create({
    data: { provider, kind: "pager", authType: "api_key", keyEnvVar, notes: "pager-gate test row" },
  });
}

beforeAll(async () => {
  // hermetic against ambient env — vitest loads the repo's .env, which now
  // carries REAL pager credentials; every test states its own env truth
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  rmSync(SCRATCH, { force: true });
  rmSync(`${SCRATCH}-journal`, { force: true });
  execSync("npx prisma db push --skip-generate", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${SCRATCH}` },
    stdio: "pipe",
  });
});

afterAll(async () => {
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  vi.unstubAllGlobals();
  await db.$disconnect();
});

describe("pager — the registry gate", () => {
  it("1. staged row + key present → refused by name, not one byte leaves", async () => {
    await seedPagerRow("slack-pager", "SLACK_WEBHOOK_URL");
    process.env.SLACK_WEBHOOK_URL = SLACK_HOOK;
    vi.stubGlobal("fetch", fakeFetch);
    const out = await deliverAlert("gate probe", "body");
    expect(out.delivered).toEqual([]);
    expect(out.attempted).toEqual([]);
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0]).toContain("integration_not_armed");
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("2. armed row + key present → fires once, to the webhook, with the payload", async () => {
    await db.integrationRecord.update({ where: { provider: "slack-pager" }, data: { status: "armed" } });
    fakeFetch.mockClear();
    const out = await deliverAlert("IRON HOT · prime", "the body line");
    expect(out.attempted).toEqual(["slack"]);
    expect(out.delivered).toEqual(["slack"]);
    expect(out.refused).toEqual([]);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SLACK_HOOK);
    expect(String(init.body)).toContain("IRON HOT · prime");
  });

  it("3. unregistered channel → refused (the star map is the allowlist)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456789:AAtest-token-for-gate-checks";
    process.env.TELEGRAM_CHAT_ID = "424242";
    fakeFetch.mockClear();
    const out = await deliverAlert("t", "b");
    // slack (armed from test 2) fires normally — only the unregistered channel refuses
    expect(out.delivered).toEqual(["slack"]);
    expect(out.refused.some((r) => r.startsWith("telegram:") && r.includes("integration_unregistered"))).toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    await seedPagerRow("telegram-pager", "TELEGRAM_BOT_TOKEN"); // registered for later tests
  });

  it("4. circuit open → refused; retired → refused", async () => {
    await db.integrationRecord.update({ where: { provider: "slack-pager" }, data: { circuitState: "open" } });
    let out = await deliverAlert("t", "b");
    expect(out.refused.some((r) => r.startsWith("slack:") && r.includes("integration_circuit_open"))).toBe(true);

    await db.integrationRecord.update({ where: { provider: "slack-pager" }, data: { circuitState: "closed", status: "retired" } });
    out = await deliverAlert("t", "b");
    expect(out.refused.some((r) => r.startsWith("slack:") && r.includes("integration_retired"))).toBe(true);
  });

  it("5. armed row + env var deleted → skipped silently (for a pager, the env check IS the key check)", async () => {
    await db.integrationRecord.update({ where: { provider: "slack-pager" }, data: { status: "armed" } });
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    const out = await deliverAlert("t", "b");
    expect(out.attempted).toEqual([]);
    expect(out.delivered).toEqual([]);
    expect(out.refused).toEqual([]); // nothing configured → nothing to refuse
  });

  it("6. no env vars at all → silent skip for both channels, no gate consults", async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    fakeFetch.mockClear();
    const out = await deliverAlert("t", "b");
    expect(out.attempted).toEqual([]);
    expect(out.delivered).toEqual([]);
    expect(out.refused).toEqual([]);
    expect(fakeFetch).not.toHaveBeenCalled();
    process.env.SLACK_WEBHOOK_URL = SLACK_HOOK; // back for the probe tests
  });
});

describe("pager — the honest probe", () => {
  it("7. probePagerChannel slack — one real test page to the exact webhook", async () => {
    const transport = vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" }) as unknown as Response);
    const r = await probePagerChannel("slack-pager", transport);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("test page");
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SLACK_HOOK);
    expect(String(init.body)).toContain("pager probe");
  });

  it("8. probePagerChannel telegram — sendMessage URL, chat_id in the body", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456789:AAtest-token-for-gate-checks";
    process.env.TELEGRAM_CHAT_ID = "424242";
    const transport = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response);
    const r = await probePagerChannel("telegram-pager", transport);
    expect(r.ok).toBe(true);
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bot123456789:AAtest-token-for-gate-checks/sendMessage");
    expect(String(init.body)).toContain('"chat_id":"424242"');
  });

  it("9. probePagerChannel telegram with the chat id missing — names the env var, fires nothing", async () => {
    delete process.env.TELEGRAM_CHAT_ID;
    const transport = vi.fn();
    const r = await probePagerChannel("telegram-pager", transport as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("TELEGRAM_CHAT_ID");
    expect(transport).not.toHaveBeenCalled();
  });

  it("10. probeIntegration pager branch — test_page_fired lands on the row; pass closes the circuit", async () => {
    const result = await probeIntegration("slack-pager", { firePager: async () => ({ ok: true, detail: "the test page is in the channel" }) });
    expect(result).toBeTruthy();
    expect(result!.ok).toBe(true);
    expect(result!.checks[0].name).toBe("test_page_fired");
    expect(result!.verdict).toContain("real test page");
    const row = await db.integrationRecord.findUnique({ where: { provider: "slack-pager" } });
    expect(row!.lastSuccessAt).toBeTruthy();
    expect(row!.circuitState).toBe("closed");
  });

  it("11. probeIntegration pager branch — a failing probe writes the evidence, never the counter", async () => {
    const result = await probeIntegration("slack-pager", { firePager: async () => ({ ok: false, detail: "Slack answered 404" }) });
    expect(result!.ok).toBe(false);
    const row = await db.integrationRecord.findUnique({ where: { provider: "slack-pager" } });
    expect(row!.lastError).toContain("test_page_fired");
    expect(row!.consecutiveFailures).toBe(0); // a probe is a diagnostic, not a call
  });
});
