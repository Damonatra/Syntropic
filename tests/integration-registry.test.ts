/**
 * Integration registry + contact resolver — the gate cases and the wire
 * formats, exercised on an isolated scratch SQLite (never the dev ledger).
 *
 *   1. the registry gate — unregistered / staged / key-missing / circuit
 *      open / retired all refuse with named reasons; armed+key passes
 *   2. the circuit — 5 consecutive failures open it, one success closes it
 *   3. enrich priority — apollo first, hunter fallback, combined refusal
 *   4. door probe requests — signed with the real scheme, verified by the
 *      real verifiers (hmacDoorValid / verifySvix)
 *   5. probeIntegration — honest about what it checked, closes the circuit
 *      only on a full pass, never pretends reachability = enrichment
 *   6. the resolver — invalid query, apollo resolve (prospect updated,
 *      ledger row, credits), no_match (0 credits, circuit stays closed),
 *      provider failure (failure recorded), circuit refusal, hunter
 *      fallback, confidence mapping
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

vi.hoisted(() => {
  // The scratch DB path must exist before @/lib/db constructs its client —
  // deterministic project-relative path (db/ is gitignored, *.db swept).
  process.env.DATABASE_URL = `file:${process.cwd()}/db/registry-test.db`;
});

import { db } from "@/lib/db";
import {
  CIRCUIT_THRESHOLD,
  KNOWN_INTEGRATIONS,
  buildDoorProbeRequest,
  computeRunway,
  deriveFleet,
  ensureKnownIntegrations,
  integrationsSnapshot,
  pickEnrichIntegration,
  probeIntegration,
  recordIntegrationFailure,
  recordIntegrationSuccess,
  resolveIntegrationGate,
} from "@/lib/vertebra/integrations";
import { resolveContact, type Transport } from "@/lib/vertebra/contacts";
import { hmacDoorValid, verifySvix } from "@/lib/vertebra/webhook-verify";

let scratchDir = "";
const apolloFixture = (payload: unknown, status = 200): Transport => {
  return () => Promise.resolve(new Response(JSON.stringify(payload), { status }));
};
const failing = (status: number, body = "boom"): Transport => {
  return () => Promise.resolve(new Response(body, { status }));
};

async function resetProvider(provider: string, data: Record<string, unknown>) {
  await db.integrationRecord.update({ where: { provider }, data: { ...data, circuitState: "closed", consecutiveFailures: 0, lastError: null, lastErrorAt: null, lastSuccessAt: null, callsTotal: 0, callsFailed: 0 } });
}

beforeAll(async () => {
  scratchDir = join(process.cwd(), "db");
  const scratchDb = join(scratchDir, "registry-test.db");
  process.env.DATABASE_URL = `file:${scratchDb}`;
  rmSync(scratchDb, { force: true });
  rmSync(`${scratchDb}-journal`, { force: true });
  execSync("npx prisma db push --skip-generate", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${scratchDb}` },
    stdio: "pipe",
  });
});

afterAll(async () => {
  await db.$disconnect().catch(() => undefined);
  // sweep ONLY the scratch database files — never the directory (custom.db lives there)
  const scratchDb = join(scratchDir, "registry-test.db");
  rmSync(scratchDb, { force: true });
  rmSync(`${scratchDb}-journal`, { force: true });
  delete process.env.APOLLO_API_KEY;
  delete process.env.HUNTER_API_KEY;
  delete process.env.INBOUND_MAIL_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
});

describe("integration registry", () => {
  it("seeds the known integrations once and stays idempotent", async () => {
    await ensureKnownIntegrations();
    await ensureKnownIntegrations();
    const rows = await db.integrationRecord.findMany();
    expect(rows.length).toBe(KNOWN_INTEGRATIONS.length);
    for (const known of KNOWN_INTEGRATIONS) {
      expect(rows.find((r) => r.provider === known.provider)?.status).toBe("staged");
    }
  });

  it("refuses an unregistered provider — the registry is the allowlist", async () => {
    const gate = await resolveIntegrationGate("never-heard-of-it");
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("integration_unregistered");
  });

  it("refuses a staged provider — arming is an operator act", async () => {
    const gate = await resolveIntegrationGate("apollo");
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("integration_not_armed");
  });

  it("refuses an armed provider whose key env var is unset — fail closed", async () => {
    await resetProvider("apollo", { status: "armed" });
    delete process.env.APOLLO_API_KEY;
    const gate = await resolveIntegrationGate("apollo");
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("integration_key_missing");
  });

  it("admits an armed provider with its key present", async () => {
    process.env.APOLLO_API_KEY = "apollo_test_key_0000000000";
    const gate = await resolveIntegrationGate("apollo");
    expect(gate.ok).toBe(true);
  });

  it("refuses an open circuit and a retired provider", async () => {
    await db.integrationRecord.update({ where: { provider: "apollo" }, data: { circuitState: "open", consecutiveFailures: 5 } });
    const open = await resolveIntegrationGate("apollo");
    expect(open.ok).toBe(false);
    if (!open.ok) expect(open.reason).toContain("integration_circuit_open");

    await db.integrationRecord.update({ where: { provider: "apollo" }, data: { circuitState: "closed", status: "retired" } });
    const retired = await resolveIntegrationGate("apollo");
    expect(retired.ok).toBe(false);
    if (!retired.ok) expect(retired.reason).toContain("integration_retired");
    await resetProvider("apollo", { status: "armed" });
  });

  it("opens the circuit at 5 consecutive failures; one success closes it", async () => {
    await resetProvider("apollo", { status: "armed" });
    for (let i = 0; i < CIRCUIT_THRESHOLD - 1; i += 1) {
      await recordIntegrationFailure("apollo", `failure ${i}`);
    }
    const before = await db.integrationRecord.findUnique({ where: { provider: "apollo" } });
    expect(before?.circuitState).toBe("closed");
    expect(before?.consecutiveFailures).toBe(CIRCUIT_THRESHOLD - 1);

    await recordIntegrationFailure("apollo", "the fifth");
    const after = await db.integrationRecord.findUnique({ where: { provider: "apollo" } });
    expect(after?.circuitState).toBe("open");
    expect(after?.status).toBe("degraded");

    await recordIntegrationSuccess("apollo");
    const healed = await db.integrationRecord.findUnique({ where: { provider: "apollo" } });
    expect(healed?.circuitState).toBe("closed");
    expect(healed?.status).toBe("armed");
    expect(healed?.consecutiveFailures).toBe(0);
  });

  it("walks enrich priority: apollo first, hunter fallback, combined refusal otherwise", async () => {
    // nothing armed → combined reason naming both
    await resetProvider("apollo", { status: "staged" });
    await resetProvider("hunter", { status: "staged" });
    delete process.env.APOLLO_API_KEY;
    delete process.env.HUNTER_API_KEY;
    const none = await pickEnrichIntegration();
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.reason).toContain("apollo");
      expect(none.reason).toContain("hunter");
    }

    // apollo armed+key → apollo
    process.env.APOLLO_API_KEY = "apollo_test_key_0000000000";
    await resetProvider("apollo", { status: "armed" });
    const first = await pickEnrichIntegration();
    expect(first.provider).toBe("apollo");

    // apollo circuit-open + hunter armed+key → hunter
    await db.integrationRecord.update({ where: { provider: "apollo" }, data: { circuitState: "open" } });
    process.env.HUNTER_API_KEY = "hunter_test_key_000000000";
    await resetProvider("hunter", { status: "armed" });
    const fallback = await pickEnrichIntegration();
    expect(fallback.provider).toBe("hunter");
    await resetProvider("apollo", { status: "staged" });
    await resetProvider("hunter", { status: "staged" });
  });

  it("builds signed door-probe requests verified by the real verifiers", async () => {
    process.env.INBOUND_MAIL_SECRET = "registry-test-mail-secret";
    const relay = buildDoorProbeRequest("mail-relay");
    expect(relay).not.toBeNull();
    if (relay) {
      expect(hmacDoorValid(relay.body, relay.headers["x-vertebra-signature"], process.env.INBOUND_MAIL_SECRET)).toBe(true);
      expect(hmacDoorValid(relay.body + "tampered", relay.headers["x-vertebra-signature"], process.env.INBOUND_MAIL_SECRET)).toBe(false);
    }

    process.env.RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from("registry-test-svix-secret-0123456789").toString("base64");
    for (const provider of ["resend-events", "resend-inbound"]) {
      const req = buildDoorProbeRequest(provider);
      expect(req).not.toBeNull();
      if (req) {
        const verdict = verifySvix(req.body, {
          id: req.headers["svix-id"],
          timestamp: req.headers["svix-timestamp"],
          signature: req.headers["svix-signature"],
        }, process.env.RESEND_WEBHOOK_SECRET);
        expect(verdict.ok).toBe(true);
      }
    }

    // no secret → the probe builder refuses honestly instead of sending junk
    delete process.env.INBOUND_MAIL_SECRET;
    expect(buildDoorProbeRequest("mail-relay")).toBeNull();
  });

  it("probes honestly: missing key fails, reachable key passes, circuit closes only on full pass", async () => {
    await resetProvider("apollo", { status: "armed" });
    await db.integrationRecord.update({ where: { provider: "apollo" }, data: { circuitState: "open", consecutiveFailures: 5 } });
    delete process.env.APOLLO_API_KEY;
    const missing = await probeIntegration("apollo", { transport: failing(500) });
    expect(missing?.ok).toBe(false);
    expect(missing?.checks.find((c) => c.name === "key_present")?.pass).toBe(false);
    // a failed probe never opens anything further — and never closes the circuit
    const stillOpen = await db.integrationRecord.findUnique({ where: { provider: "apollo" } });
    expect(stillOpen?.circuitState).toBe("open");

    process.env.APOLLO_API_KEY = "apollo_test_key_0000000000";
    const passed = await probeIntegration("apollo", { transport: apolloFixture({ ok: true }) });
    expect(passed?.ok).toBe(true);
    const healed = await db.integrationRecord.findUnique({ where: { provider: "apollo" } });
    expect(healed?.circuitState).toBe("closed");
    expect(healed?.consecutiveFailures).toBe(0);
    expect(healed?.lastSuccessAt).not.toBeNull();
  });

  it("probe through a real door: 401 fails, 200 passes", async () => {
    process.env.INBOUND_MAIL_SECRET = "registry-test-mail-secret";
    await resetProvider("mail-relay", { status: "armed", circuitState: "open", consecutiveFailures: 2 });
    const rejected = await probeIntegration("mail-relay", { fireDoor: async () => ({ status: 401, body: '{"error":"missing_or_invalid_signature"}' }) });
    expect(rejected?.ok).toBe(false);

    const admitted = await probeIntegration("mail-relay", { fireDoor: async () => ({ status: 202, body: '{"ok":true,"matched":false}' }) });
    expect(admitted?.ok).toBe(true);
    expect(admitted?.checks.find((c) => c.name === "door_signature")?.pass).toBe(true);
    const healed = await db.integrationRecord.findUnique({ where: { provider: "mail-relay" } });
    expect(healed?.circuitState).toBe("closed");

    // the 502 case: signature admitted, provider body fetch failed — the door is healthy
    process.env.RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from("registry-test-svix-secret-0123456789").toString("base64");
    const inbound502 = await probeIntegration("resend-inbound", { fireDoor: async () => ({ status: 502, body: '{"error":"body_fetch_failed"}' }) });
    expect(inbound502?.ok).toBe(true);
    expect(inbound502?.checks.find((c) => c.name === "provider_leg")?.detail).toContain("live provider key");
  });

  it("snapshot joins live env truth", async () => {
    process.env.APOLLO_API_KEY = "apollo_test_key_0000000000";
    delete process.env.HUNTER_API_KEY;
    const { integrations } = await integrationsSnapshot();
    const apollo = integrations.find((i) => i.provider === "apollo");
    const hunter = integrations.find((i) => i.provider === "hunter");
    expect(apollo?.keyPresent).toBe(true);
    expect(hunter?.keyPresent).toBe(false);
    expect(apollo?.label).toContain("Apollo");
  });
});

describe("contact resolver", () => {
  const NAME = "Vera Lyan";
  const DOMAIN = "acme.test";

  function prospect(name: string) {
    return db.prospect.create({ data: { name, domainKey: `registry-test:${name}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } });
  }

  it("refuses a query without a person or a place — ledgered, named", async () => {
    const outcome = await resolveContact({ query: { name: "Vera Lyan" } });
    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain("invalid_query");
    expect(outcome.provider).toBe("none");
    const row = await db.contactResolution.findUnique({ where: { id: outcome.resolutionId! } });
    expect(row?.outcome).toBe("refused");
    expect(row?.refuseReason).toContain("invalid_query");
  });

  it("refuses when no enrich provider is armed — both reasons carried", async () => {
    await resetProvider("apollo", { status: "staged" });
    await resetProvider("hunter", { status: "staged" });
    delete process.env.APOLLO_API_KEY;
    delete process.env.HUNTER_API_KEY;
    const outcome = await resolveContact({ query: { name: NAME, domain: DOMAIN } });
    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain("no_armed_enrich_provider");
  });

  it("resolves through apollo: prospect updated, ledger row, credits, success recorded", async () => {
    process.env.APOLLO_API_KEY = "apollo_test_key_0000000000";
    await resetProvider("apollo", { status: "armed" });
    await resetProvider("hunter", { status: "staged" });
    const p = await prospect("Resolver Happy Path");

    const outcome = await resolveContact({
      query: { name: NAME, domain: DOMAIN, role: "Ops Director" },
      prospectId: p.id,
      transport: apolloFixture({ person: { email: "vera@acme.test", email_status: "verified", organization: { email_pattern: "{first}@acme.test" } } }),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("resolved");
    expect(outcome.provider).toBe("apollo");
    expect(outcome.email).toBe("vera@acme.test");
    expect(outcome.confidence).toBe("high");
    expect(outcome.creditsUsed).toBe(1);
    expect(outcome.prospectUpdated).toBe(true);

    const updated = await db.prospect.findUnique({ where: { id: p.id } });
    expect(updated?.bestEmail).toBe("vera@acme.test");
    expect(updated?.emailPattern).toBe("{first}@acme.test");

    const row = await db.contactResolution.findUnique({ where: { id: outcome.resolutionId! } });
    expect(row?.outcome).toBe("resolved");
    expect(row?.email).toBe("vera@acme.test");
    expect(row?.creditsUsed).toBe(1);
    expect(row?.actor).toBe("operator");

    const integration = await db.integrationRecord.findUnique({ where: { provider: "apollo" } });
    expect(integration?.lastSuccessAt).not.toBeNull();
    expect(integration?.circuitState).toBe("closed");
  });

  it("medium confidence from a guessed apollo status; pattern carried", async () => {
    const p = await prospect("Resolver Medium");
    const outcome = await resolveContact({
      query: { name: NAME, domain: DOMAIN },
      prospectId: p.id,
      transport: apolloFixture({ person: { email: "vera.lyan@acme.test", email_status: "guessed", organization: { email_pattern: "{first}{last}@acme.test" } } }),
    });
    expect(outcome.confidence).toBe("medium");
    expect(outcome.pattern).toBe("{first}{last}@acme.test");
  });

  it("no_match is an integration success: zero credits, circuit closed, prospect untouched", async () => {
    await resetProvider("apollo", { status: "armed" });
    const p = await prospect("Resolver No Match");
    const before = await db.prospect.findUnique({ where: { id: p.id } });

    const outcome = await resolveContact({
      query: { name: NAME, domain: DOMAIN },
      prospectId: p.id,
      transport: apolloFixture({}),
    });
    expect(outcome.status).toBe("no_match");
    expect(outcome.creditsUsed).toBe(0);
    const after = await db.prospect.findUnique({ where: { id: p.id } });
    expect(after?.bestEmail).toBe(before?.bestEmail);
    const integration = await db.integrationRecord.findUnique({ where: { provider: "apollo" } });
    expect(integration?.circuitState).toBe("closed");
    const row = await db.contactResolution.findUnique({ where: { id: outcome.resolutionId! } });
    expect(row?.outcome).toBe("no_match");
  });

  it("provider failure is named, failure-counted, and refused", async () => {
    await resetProvider("apollo", { status: "armed" });
    const outcome = await resolveContact({ query: { name: NAME, domain: DOMAIN }, transport: failing(500, "apollo exploded") });
    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toContain("provider_error");
    expect(outcome.reason).toContain("apollo_http_500");
    const integration = await db.integrationRecord.findUnique({ where: { provider: "apollo" } });
    expect(integration?.callsFailed).toBeGreaterThan(0);
    expect(integration?.lastError).toContain("provider_error");
  });

  it("the fifth consecutive failure opens the circuit; the resolver then refuses without calling", async () => {
    await resetProvider("apollo", { status: "armed" });
    let called = 0;
    const counting: Transport = () => {
      called += 1;
      return Promise.resolve(new Response("down", { status: 503 }));
    };
    for (let i = 0; i < CIRCUIT_THRESHOLD; i += 1) {
      await resolveContact({ query: { name: NAME, domain: DOMAIN }, transport: counting });
    }
    expect(called).toBe(CIRCUIT_THRESHOLD);
    const integration = await db.integrationRecord.findUnique({ where: { provider: "apollo" } });
    expect(integration?.circuitState).toBe("open");

    const refused = await resolveContact({ query: { name: NAME, domain: DOMAIN }, transport: counting });
    expect(called).toBe(CIRCUIT_THRESHOLD); // the open circuit spared the provider
    expect(refused.status).toBe("refused");
    expect(refused.reason).toContain("integration_circuit_open");
  });

  it("falls back to hunter when apollo is open — hunter's score maps to confidence", async () => {
    await db.integrationRecord.update({ where: { provider: "apollo" }, data: { circuitState: "open" } });
    process.env.HUNTER_API_KEY = "hunter_test_key_000000000";
    await resetProvider("hunter", { status: "armed" });
    const p = await prospect("Resolver Fallback");

    const outcome = await resolveContact({
      query: { name: NAME, domain: DOMAIN },
      prospectId: p.id,
      transport: (url) => {
        expect(String(url)).toContain("api.hunter.io/v2/email-finder");
        expect(String(url)).toContain("first_name=Vera");
        return Promise.resolve(new Response(JSON.stringify({ data: { email: "vera@acme.test", score: 82 } }), { status: 200 }));
      },
    });
    expect(outcome.provider).toBe("hunter");
    expect(outcome.status).toBe("resolved");
    expect(outcome.confidence).toBe("medium");
    expect(outcome.prospectUpdated).toBe(true);
    await resetProvider("apollo", { status: "staged" });
    await resetProvider("hunter", { status: "staged" });
  });
});

describe("runway, fleet, and watchtower pulses", () => {
  const NOW = Date.now();

  it("computeRunway: measured pace, honest about unknown balances", () => {
    // healthy: 35 credits over 7d → 5/day, 100 left → 20 days of runway
    const ok = computeRunway(100, 35, NOW);
    expect(ok.creditsPerDay).toBe(5);
    expect(ok.dryInDays).toBe(20);
    expect(ok.level).toBe("ok");
    expect(ok.dryAtDate).not.toBeNull();

    // warn: 6 days left (≤14)
    expect(computeRunway(30, 35, NOW).level).toBe("warn");
    // crit: 2 days left (≤3)
    expect(computeRunway(10, 35, NOW).level).toBe("crit");
    // crit by absolute floor even with no pace
    const floored = computeRunway(4, 0, NOW);
    expect(floored.dryInDays).toBeNull();
    expect(floored.dryAtDate).toBeNull();
    expect(floored.level).toBe("crit");
    // unknown balance → pace-only, never an invented date
    const paceOnly = computeRunway(null, 14, NOW);
    expect(paceOnly.creditsPerDay).toBe(2);
    expect(paceOnly.dryInDays).toBeNull();
    expect(paceOnly.dryAtDate).toBeNull();
    expect(paceOnly.level).toBe("ok");
  });

  it("deriveFleet: verdicts name the actual blocking condition", () => {
    const row = (status: string, circuitState = "closed", keyPresent = true) => ({ status, circuitState, keyPresent });
    expect(deriveFleet([row("armed"), row("armed"), row("staged")]).verdict).toContain("nominal");
    expect(deriveFleet([row("staged"), row("staged")]).verdict).toContain("unarmed");
    expect(deriveFleet([row("armed", "open")]).verdict).toContain("degraded");
    expect(deriveFleet([row("armed", "closed", false)]).verdict).toContain("armed but unkeyed");
    const fleet = deriveFleet([row("armed", "closed", false), row("armed"), row("staged"), row("retired")]);
    expect(fleet.armed).toBe(2);
    expect(fleet.staged).toBe(1);
    expect(fleet.retired).toBe(1);
    expect(fleet.armedKeyMissing).toBe(1);
  });

  it("snapshot counts refusals and computes runway from the resolution ledger", async () => {
    // hermetic slice — earlier resolver tests leave apollo ledger rows behind
    await db.contactResolution.deleteMany({ where: { provider: "apollo" } });
    await db.contactResolution.deleteMany({ where: { provider: "none", outcome: "refused" } });
    await resetProvider("apollo", { status: "armed" });
    await db.contactResolution.createMany({
      data: [
        { provider: "apollo", queryJson: "{}", outcome: "refused", refuseReason: "integration_circuit_open: test" },
        { provider: "apollo", queryJson: "{}", outcome: "refused", refuseReason: "integration_key_missing: test" },
        { provider: "apollo", queryJson: "{}", outcome: "resolved", email: "a@acme.test", creditsUsed: 7 },
        { provider: "apollo", queryJson: "{}", outcome: "resolved", email: "b@acme.test", creditsUsed: 7 },
      ],
    });
    const { integrations, gateRefusals24h } = await integrationsSnapshot();
    const apollo = integrations.find((i) => i.provider === "apollo");
    expect(apollo?.refusals24h).toBe(2);
    expect(apollo?.refusalsTotal).toBe(2);
    expect(apollo?.runway?.creditsSpent7d).toBe(14);
    expect(apollo?.runway?.creditsPerDay).toBe(2);
    // no balance declared → pace-only, no invented dry date
    expect(apollo?.runway?.dryAtDate).toBeNull();
    // gate-level refusals (provider "none") surface on the fleet line
    expect(gateRefusals24h).toBe(0);
    await db.contactResolution.create({
      data: { provider: "none", queryJson: "{}", outcome: "refused", refuseReason: "integration_not_armed: test" },
    });
    expect((await integrationsSnapshot()).gateRefusals24h).toBe(1);
  });

  it("a circuit opening pages the watchtower exactly once per hour bucket", async () => {
    await db.enginePulse.deleteMany({});
    await resetProvider("apollo", { status: "armed" });
    for (let i = 0; i < CIRCUIT_THRESHOLD; i += 1) {
      await recordIntegrationFailure("apollo", `failure ${i}`);
    }
    // the circuit is now open — further failures never transition again
    await recordIntegrationFailure("apollo", "while already open");
    const pulses = await db.enginePulse.findMany({ where: { watchId: "circuit_open", engineId: "enclave-registry:apollo" } });
    expect(pulses.length).toBe(1);
    expect(pulses[0]?.status).toBe("fail");
    expect(pulses[0]?.detail).toContain("circuit open");
  });

  it("runway warn/crit reaches the watchtower once per day per level", async () => {
    await db.enginePulse.deleteMany({});
    await db.contactResolution.deleteMany({ where: { provider: "apollo" } });
    await resetProvider("apollo", { status: "armed" });
    await db.integrationRecord.update({ where: { provider: "apollo" }, data: { quotaRemaining: 30 } });
    await db.contactResolution.createMany({
      data: [
        { provider: "apollo", queryJson: "{}", outcome: "resolved", email: "c@acme.test", creditsUsed: 20 },
        { provider: "apollo", queryJson: "{}", outcome: "resolved", email: "d@acme.test", creditsUsed: 15 },
      ],
    });
    // 30 remaining / (35/7 per day) = 6 days → warn; the panel polls every
    // 30s, so a second snapshot in the same day must dedup, not nag
    await integrationsSnapshot();
    await integrationsSnapshot();
    const pulses = await db.enginePulse.findMany({ where: { watchId: "quota_runway", engineId: "enclave-registry:apollo" } });
    expect(pulses.length).toBe(1);
    expect(pulses[0]?.status).toBe("warn");
    expect(pulses[0]?.detail).toContain("apollo");
    await db.integrationRecord.update({ where: { provider: "apollo" }, data: { quotaRemaining: null } });
  });
});
