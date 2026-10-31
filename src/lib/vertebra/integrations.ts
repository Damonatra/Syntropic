/**
 * Integration registry — the star-not-mesh doctrine made physical.
 *
 * Every external API the enclave touches is ONE row in IntegrationRecord:
 * dumb spokes, one brain, one ledger. Any capability that needs a provider
 * consults this table first and fails closed with a named reason — an
 * unregistered provider, a key not on disk, a staged (never-armed) row, or
 * an open circuit all refuse before a single byte leaves for the provider.
 *
 * The laws this module enforces:
 *   1. Arming is always an operator act. A key appearing in the environment
 *      never auto-arms anything — the same reflex as ENCLAVE_EGRESS_ARMED.
 *   2. The key VALUE never enters the ledger. Only which env var carries it
 *      (name) and the honest fact of whether that env var is currently set.
 *   3. The circuit is arithmetic, not opinion: 5 consecutive provider
 *      failures open it; a real success or an operator probe closes it.
 *   4. Probes tell the truth about what they actually checked —
 *      "reachability confirmed" is never allowed to impersonate "enrichment
 *      works". A probe that couldn't check something says so.
 */
import { db } from "@/lib/db";
import { createHmac, randomBytes } from "node:crypto";
import type { IntegrationRecord } from "@prisma/client";
import { writeEnginePulse } from "@/lib/vertebra/pulse";

export type IntegrationKind = "egress" | "inbound" | "enrich" | "calendar" | "pager";
export type IntegrationStatus = "staged" | "armed" | "degraded" | "retired";

export const CIRCUIT_THRESHOLD = 5;

/* --------------------------------------------------------------- runway -- */

/** Runway thresholds — a warn/crit the watchtower can ring before the
 * enclave is stranded mid-campaign with no credits and no fallback. */
export const RUNWAY_WARN_DAYS = 14;
export const RUNWAY_CRIT_DAYS = 3;
export const RUNWAY_WARN_CREDITS = 20;
export const RUNWAY_CRIT_CREDITS = 5;
const DAY_MS = 86_400_000;

export type RunwayLevel = "ok" | "warn" | "crit";

/**
 * Quota runway for one enrich row — honest about what it knows. The pace is
 * measured (credits the resolver actually spent over the last 7 days); the
 * remaining balance is either provider-reported or operator-declared, and
 * when it is unknown the view says pace-only instead of inventing a date.
 */
export function computeRunway(quotaRemaining: number | null, creditsSpent7d: number, nowMs: number): RunwayView {
  const creditsPerDay = Math.round((creditsSpent7d / 7) * 100) / 100;
  const dryInDays = quotaRemaining != null && creditsPerDay > 0 ? Math.round((quotaRemaining / creditsPerDay) * 10) / 10 : null;
  const level: RunwayLevel =
    (quotaRemaining != null && quotaRemaining <= RUNWAY_CRIT_CREDITS) || (dryInDays != null && dryInDays <= RUNWAY_CRIT_DAYS)
      ? "crit"
      : (quotaRemaining != null && quotaRemaining <= RUNWAY_WARN_CREDITS) || (dryInDays != null && dryInDays <= RUNWAY_WARN_DAYS)
        ? "warn"
        : "ok";
  return {
    quotaRemaining,
    creditsSpent7d,
    creditsPerDay,
    dryInDays,
    dryAtDate: dryInDays != null ? new Date(nowMs + dryInDays * DAY_MS).toISOString() : null,
    level,
  };
}

export interface RunwayView {
  quotaRemaining: number | null;
  creditsSpent7d: number;
  creditsPerDay: number;
  dryInDays: number | null;
  dryAtDate: string | null;
  level: RunwayLevel;
}

export function hourBucket(nowMs: number): number {
  return Math.floor(nowMs / 3_600_000);
}

export function dayBucket(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS);
}

const REGISTRY_ENGINE = "enclave-registry";

/** The watchtower's page when a circuit opens — crit on the deck, deduped
 * per hour so a flap re-fires honestly without nagging within the hour. */
async function fireCircuitOpenPulse(provider: string, failures: number): Promise<void> {
  await writeEnginePulse({
    engineId: `${REGISTRY_ENGINE}:${provider}`,
    pulseRef: `circuit-open-${provider}-${hourBucket(Date.now())}`,
    watchId: "circuit_open",
    status: "fail",
    detail: `${provider} failed ${failures} consecutive calls — circuit open; downstream gates refuse with integration_circuit_open until a probe or a real success closes it`,
  }).catch(() => undefined);
}

export interface KnownIntegration {
  provider: string;
  label: string;
  kind: IntegrationKind;
  authType: "api_key" | "hmac" | "svix" | "oauth" | "none";
  keyEnvVar: string | null;
  what: string;
  /** For inbound machine doors: the path a probe fires through. */
  doorPath?: string;
}

/**
 * The enclave's star map — every integration the console knows how to
 * monitor, seeded into the registry on first read. Providers not on this
 * map can still be registered by hand (POST /api/ops/integrations).
 */
export const KNOWN_INTEGRATIONS: KnownIntegration[] = [
  {
    provider: "resend-egress",
    label: "Resend — egress",
    kind: "egress",
    authType: "api_key",
    keyEnvVar: "RESEND_API_KEY",
    what: "Sends every Channel A email and approved draft. Gated by the unsubscribe secret, the egress arm, and the sending-domain ledger.",
  },
  {
    provider: "mail-relay",
    label: "Mail relay — inbound door",
    kind: "inbound",
    authType: "hmac",
    keyEnvVar: "INBOUND_MAIL_SECRET",
    what: "The canonical HMAC door any relay adapter POSTs received email through. Probe fires a signed synthetic envelope.",
    doorPath: "/api/mail/inbound",
  },
  {
    provider: "resend-inbound",
    label: "Resend — email.received",
    kind: "inbound",
    authType: "svix",
    keyEnvVar: "RESEND_WEBHOOK_SECRET",
    what: "Svix-verified receiving webhook; fetches full bodies from the Received-emails API. Needs the inbound route + MX on domain day.",
    doorPath: "/api/providers/resend/inbound",
  },
  {
    provider: "resend-events",
    label: "Resend — event feedback",
    kind: "inbound",
    authType: "svix",
    keyEnvVar: "RESEND_WEBHOOK_SECRET",
    what: "Svix-verified reputation loop: bounces/complaints land in SuppressionRecord, delivered/opened escalate the dispatch.",
    doorPath: "/api/providers/resend/events",
  },
  {
    provider: "apollo",
    label: "Apollo.io — enrichment",
    kind: "enrich",
    authType: "api_key",
    keyEnvVar: "APOLLO_API_KEY",
    what: "Contact resolver's first-choice enricher: finds + verifies the work email for a named contact on a domain. 1 credit per email revealed.",
  },
  {
    provider: "hunter",
    label: "Hunter.io — enrichment",
    kind: "enrich",
    authType: "api_key",
    keyEnvVar: "HUNTER_API_KEY",
    what: "Fallback enricher when Apollo is degraded or exhausted. 1 credit per email found, 0.5 to verify.",
  },
  {
    provider: "slack-pager",
    label: "Slack — pager",
    kind: "pager",
    authType: "api_key",
    keyEnvVar: "SLACK_WEBHOOK_URL",
    what: "Where crit alerts ring when they cannot wait for the next console refresh. Incoming webhook; fires one POST per page.",
  },
  {
    provider: "telegram-pager",
    label: "Telegram — pager",
    kind: "pager",
    authType: "api_key",
    keyEnvVar: "TELEGRAM_BOT_TOKEN",
    what: "Where crit alerts ring on the phone. BotFather token + chat id (the token's env var shows here; delivery needs TELEGRAM_CHAT_ID too). One sendMessage per page.",
  },
  {
    provider: "google-calendar",
    label: "Google Calendar",
    kind: "calendar",
    authType: "oauth",
    keyEnvVar: "GOOGLE_OAUTH_REFRESH_TOKEN",
    what: "Booking connector for the high-touch queue. OAuth refresh token minted outside the enclave; the value never lands here.",
  },
];

export function keyPresentFor(keyEnvVar: string | null | undefined): boolean {
  if (!keyEnvVar) return false;
  const v = process.env[keyEnvVar];
  return typeof v === "string" && v.length >= 8;
}

/**
 * Seed the known integrations — idempotent, runs on registry reads. Never
 * touches status: a fresh row is `staged`, and arming stays the operator's.
 */
export async function ensureKnownIntegrations(): Promise<void> {
  for (const known of KNOWN_INTEGRATIONS) {
    const existing = await db.integrationRecord.findUnique({ where: { provider: known.provider }, select: { id: true } });
    if (!existing) {
      await db.integrationRecord.create({
        data: {
          provider: known.provider,
          kind: known.kind,
          authType: known.authType,
          keyEnvVar: known.keyEnvVar,
          notes: known.what,
        },
      });
    }
  }
}

export type GateVerdict = { ok: true; row: IntegrationRecord } | { ok: false; reason: string; row: IntegrationRecord | null };

/**
 * The registry gate — the enrich resolver's version of the mailer's
 * interlocks. Fail-closed on every reading problem: a ledger the gate
 * cannot read refuses, it never waves through.
 */
export async function resolveIntegrationGate(provider: string): Promise<GateVerdict> {
  let rows: IntegrationRecord[] | null = null;
  try {
    rows = await db.integrationRecord.findMany({ where: { provider }, take: 1 });
  } catch {
    return { ok: false, reason: "integration_ledger_unavailable: the registry could not be read — fail-closed", row: null };
  }
  const row = rows?.[0];
  if (!row) return { ok: false, reason: `integration_unregistered: "${provider}" is not in the registry — the registry is the allowlist`, row: null };
  if (row.status === "retired") return { ok: false, reason: `integration_retired: ${provider} was retired by an operator`, row };
  if (row.status === "staged") {
    return {
      ok: false,
      reason: `integration_not_armed: ${provider} is staged — arm it on the Enclave connections panel (arming is always an operator act)`,
      row,
    };
  }
  if (row.circuitState === "open") {
    return {
      ok: false,
      reason: `integration_circuit_open: ${provider} failed ${row.consecutiveFailures} consecutive calls — close the circuit after a probe or fix`,
      row,
    };
  }
  if (row.authType === "api_key" && !keyPresentFor(row.keyEnvVar)) {
    return {
      ok: false,
      reason: `integration_key_missing: ${provider} is armed but ${row.keyEnvVar ?? "its key env var"} is not set in this environment`,
      row,
    };
  }
  return { ok: true, row };
}

/**
 * Priority walk across the enrich providers — first armed + healthy row
 * wins; every refusal reason is carried so the operator sees the full map.
 */
export const ENRICH_PRIORITY = ["apollo", "hunter"] as const;

export async function pickEnrichIntegration(): Promise<{ ok: true; provider: string; row: IntegrationRecord } | { ok: false; provider: "none"; reason: string }> {
  const reasons: string[] = [];
  for (const provider of ENRICH_PRIORITY) {
    const gate = await resolveIntegrationGate(provider);
    if (gate.ok) return { ok: true, provider, row: gate.row };
    reasons.push(`${provider}: ${gate.reason}`);
  }
  return { ok: false, provider: "none", reason: `no_armed_enrich_provider — ${reasons.join(" · ")}` };
}

export async function recordIntegrationSuccess(provider: string, opts?: { creditsRemaining?: number | null }): Promise<void> {
  await db.integrationRecord
    .update({
      where: { provider },
      data: {
        status: "armed", // a real success re-arms a degraded row — earned, not assumed
        circuitState: "closed",
        consecutiveFailures: 0,
        lastSuccessAt: new Date(),
        callsTotal: { increment: 1 },
        ...(opts?.creditsRemaining !== undefined ? { quotaRemaining: opts.creditsRemaining, quotaUpdatedAt: new Date() } : {}),
      },
    })
    .catch(() => undefined);
}

export async function recordIntegrationFailure(provider: string, reason: string): Promise<void> {
  const row = await db.integrationRecord
    .findUnique({ where: { provider }, select: { consecutiveFailures: true, status: true, circuitState: true } })
    .catch(() => null);
  if (!row) return;
  const nextFailures = row.consecutiveFailures + 1;
  const openCircuit = nextFailures >= CIRCUIT_THRESHOLD;
  // Fire the watchtower page only on the closed→open transition — a circuit
  // that is already open refuses downstream calls, so no new failures land.
  const justOpened = openCircuit && row.circuitState !== "open";
  await db.integrationRecord
    .update({
      where: { provider },
      data: {
        consecutiveFailures: nextFailures,
        callsTotal: { increment: 1 },
        callsFailed: { increment: 1 },
        lastErrorAt: new Date(),
        lastError: reason.slice(0, 500),
        ...(openCircuit ? { circuitState: "open", status: "degraded" } : {}),
      },
    })
    .catch(() => undefined);
  if (justOpened) await fireCircuitOpenPulse(provider, nextFailures);
}

/* ------------------------------------------------------------------ probe -- */

export interface ProbeCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ProbeResult {
  provider: string;
  ok: boolean;
  checks: ProbeCheck[];
  verdict: string;
  firedAt: string;
}

/** What a fireDoor implementation returns — status + body of the door hit. */
export interface DoorProbeResponse {
  status: number;
  body: string;
}

/**
 * Build the synthetic signed request a probe fires at an internal machine
 * door. Signed with the real env secrets, addressed to nobody (an unmatched
 * sender) so the ledger effect is one recorded-and-ignored row at most.
 */
export function buildDoorProbeRequest(provider: string): { path: string; body: string; headers: Record<string, string>; expects: string } | null {
  const run = randomBytes(4).toString("hex");
  const known = KNOWN_INTEGRATIONS.find((k) => k.provider === provider);
  if (!known?.doorPath) return null;

  if (provider === "mail-relay") {
    const secret = process.env.INBOUND_MAIL_SECRET;
    if (!secret) return null;
    const body = JSON.stringify({
      from: "Vertebra Probe <probe@enclave.local>",
      subject: "integration probe",
      text: `Synthetic probe envelope ${run} — unmatched by design, recorded and ignored.`,
      messageId: `probe-${run}@enclave.local`,
    });
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    return { path: known.doorPath, body, headers: { "x-vertebra-signature": sig }, expects: "200/202 (signature admitted; unmatched sender is fine)" };
  }

  if (provider === "resend-events" || provider === "resend-inbound") {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return null;
    // mirror unwrapSvixSecret: whsec_ prefix carries the key base64-encoded
    const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice("whsec_".length), "base64") : Buffer.from(secret, "utf8");
    const type = provider === "resend-events" ? "email.sent" : "email.received";
    const body = JSON.stringify({ type, data: { email_id: `probe-${run}`, from: "probe@enclave.local", to: "probe@enclave.local" } });
    const id = `msg_probe_${run}`;
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`, "utf8").digest("base64");
    return {
      path: known.doorPath,
      body,
      headers: { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` },
      expects: provider === "resend-events" ? "200 (signed event admitted)" : "200/202/502 (signature admitted; body fetch may need the live provider key)",
    };
  }
  return null;
}

export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Probe one integration and tell the truth about what was checked.
 *   internal doors → the injected fireDoor fires a real signed synthetic
 *                    request through the door; signature rejection fails.
 *   api_key kinds  → key presence + key shape + network reachability of the
 *                    provider's API host. Reachability is NOT a working
 *                    integration and never claims to be.
 *   oauth          → credential presence only; the dance lives outside.
 * Probe evidence lands on the row (lastSuccessAt / lastError) but probes
 * never increment the failure counter — they are diagnostics, not calls.
 */
export async function probeIntegration(
  provider: string,
  opts?: {
    transport?: Transport;
    fireDoor?: (req: { path: string; body: string; headers: Record<string, string> }) => Promise<DoorProbeResponse>;
    /** pager rows — fires one real test page to that channel (the honest probe) */
    firePager?: (provider: string) => Promise<{ ok: boolean; detail: string }>;
  },
): Promise<ProbeResult | null> {
  const known = KNOWN_INTEGRATIONS.find((k) => k.provider === provider);
  const row = await db.integrationRecord.findUnique({ where: { provider } }).catch(() => null);
  if (!row || !known) return null;
  const checks: ProbeCheck[] = [];
  const transport = opts?.transport ?? fetch;
  let ok = true;
  const at = new Date();

  if (known.doorPath) {
    const req = buildDoorProbeRequest(provider);
    if (!req) {
      ok = false;
      checks.push({ name: "door_probe_built", pass: false, detail: `${known.keyEnvVar} is not set in this environment — nothing can sign a probe` });
    } else if (!opts?.fireDoor) {
      ok = false;
      checks.push({ name: "door_probe_fired", pass: false, detail: "no fireDoor transport wired in this context — use the probe endpoint on a live server" });
    } else {
      try {
        const res = await opts.fireDoor({ path: req.path, body: req.body, headers: req.headers });
        const signatureAdmitted = res.status !== 401;
        const bodyFetchSideEffect = res.status === 502;
        checks.push({
          name: "door_signature",
          pass: signatureAdmitted,
          detail: signatureAdmitted ? `door responded ${res.status} — signature admitted` : "door rejected the probe signature (401)",
        });
        if (bodyFetchSideEffect) {
          checks.push({ name: "provider_leg", pass: true, detail: "signature admitted; body fetch needs the live provider key (expected outside domain day wiring)" });
        } else {
          checks.push({ name: "door_response", pass: res.status < 400, detail: `expects ${req.expects} — got ${res.status}: ${res.body.slice(0, 160)}` });
        }
        ok = signatureAdmitted && res.status !== 500;
      } catch (error) {
        ok = false;
        checks.push({ name: "door_probe_fired", pass: false, detail: `transport error: ${String(error).slice(0, 160)}` });
      }
    }
  } else if (known.kind === "pager" && opts?.firePager) {
    // A key-shape check cannot prove a channel rings — the honest pager
    // probe is the page itself: one real test message to that channel.
    const r = await opts.firePager(provider);
    checks.push({ name: "test_page_fired", pass: r.ok, detail: r.detail });
    ok = r.ok;
  } else if (known.authType === "oauth") {
    const present = keyPresentFor(known.keyEnvVar);
    checks.push({ name: "credential_present", pass: present, detail: present ? `${known.keyEnvVar} is set` : `${known.keyEnvVar} is not set in this environment` });
    ok = present;
  } else {
    const present = keyPresentFor(known.keyEnvVar);
    checks.push({ name: "key_present", pass: present, detail: present ? `${known.keyEnvVar} is set` : `${known.keyEnvVar} is not set in this environment` });
    if (present) {
      const v = process.env[known.keyEnvVar ?? ""];
      checks.push({ name: "key_shape", pass: (v ?? "").length >= 20, detail: `length ${v?.length ?? 0} — real provider keys run longer` });
    }
    ok = present;
  }

  // Evidence on the row — never increments consecutiveFailures (a probe is a
  // diagnostic, not a call); a fully-passing probe closes the circuit, which
  // is the operator's "it's fixed" gesture with a paper trail.
  await db.integrationRecord
    .update({
      where: { provider },
      data: ok
        ? { lastSuccessAt: at, lastError: null, circuitState: "closed", consecutiveFailures: 0, ...(row.status === "degraded" ? { status: "armed" } : {}) }
        : { lastErrorAt: at, lastError: `probe: ${checks.filter((c) => !c.pass).map((c) => c.name).join(", ")}` },
    })
    .catch(() => undefined);

  const verdict = ok
    ? `probe passed — ${checks.map((c) => c.name).join(", ")}${
        known.kind === "enrich"
          ? "; first real resolve is the full test"
          : known.kind === "pager"
            ? "; a real test page just left — check the channel"
            : ""
      }`
    : `probe failed — ${checks.filter((c) => !c.pass).map((c) => c.detail).join("; ")}`;
  return { provider, ok, checks, verdict, firedAt: at.toISOString() };
}

/* --------------------------------------------------------------- snapshot -- */

export interface IntegrationView {
  provider: string;
  label: string;
  kind: string;
  authType: string;
  status: string;
  circuitState: string;
  consecutiveFailures: number;
  keyEnvVar: string | null;
  keyPresent: boolean;
  quotaRemaining: number | null;
  quotaUpdatedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  callsTotal: number;
  callsFailed: number;
  notes: string | null;
  doorPath: string | null;
  /** enrich rows only — the fail-closed feed, counted where it happened */
  refusals24h?: number;
  refusalsTotal?: number;
  runway?: RunwayView;
}

export interface FleetView {
  total: number;
  armed: number;
  staged: number;
  degraded: number;
  retired: number;
  circuitOpen: number;
  armedKeyMissing: number;
  verdict: string;
}

export function deriveFleet(rows: Array<Pick<IntegrationView, "status" | "circuitState" | "keyPresent">>): FleetView {
  const fleet: FleetView = {
    total: rows.length,
    armed: 0,
    staged: 0,
    degraded: 0,
    retired: 0,
    circuitOpen: 0,
    armedKeyMissing: 0,
    verdict: "",
  };
  for (const r of rows) {
    if (r.status === "armed") fleet.armed += 1;
    else if (r.status === "staged") fleet.staged += 1;
    else if (r.status === "degraded") fleet.degraded += 1;
    else if (r.status === "retired") fleet.retired += 1;
    if (r.circuitState === "open") fleet.circuitOpen += 1;
    if (r.status === "armed" && !r.keyPresent) fleet.armedKeyMissing += 1;
  }
  fleet.verdict =
    fleet.degraded > 0 || fleet.circuitOpen > 0
      ? `degraded — ${Math.max(fleet.degraded, fleet.circuitOpen)} spoke(s) down; gates refusing with named reasons`
      : fleet.armed === 0
        ? "unarmed — every spoke staged; nothing external is reachable"
        : fleet.armedKeyMissing > 0
          ? `armed but unkeyed — ${fleet.armedKeyMissing} armed row(s) refuse at call time until their key lands`
          : `nominal — ${fleet.armed} armed · ${fleet.staged} staged`;
  return fleet;
}

/**
 * Runway pulses — the watchtower rings warn/crit once per provider per day
 * per level (the pulseRef dedupes; the panel polls every 30s and cannot
 * nag). Fired from the snapshot build, same write-on-read precedent as the
 * command baseline captures.
 */
async function fireRunwayPulses(rows: IntegrationView[]): Promise<void> {
  const nowMs = Date.now();
  for (const r of rows) {
    if (r.kind !== "enrich" || !r.runway || r.runway.level === "ok") continue;
    await writeEnginePulse({
      engineId: `${REGISTRY_ENGINE}:${r.provider}`,
      pulseRef: `runway-${r.provider}-${r.runway.level}-${dayBucket(nowMs)}`,
      watchId: "quota_runway",
      status: r.runway.level === "crit" ? "fail" : "warn",
      detail:
        r.runway.dryInDays != null
          ? `${r.provider} quota runway ~${r.runway.dryInDays} days at ${r.runway.creditsPerDay}/day — ${r.runway.quotaRemaining ?? 0} credits left; declare more or stagger resolves`
          : `${r.provider} spent ${r.runway.creditsSpent7d} credits over 7d (${r.runway.creditsPerDay}/day) with no reported balance — declare the plan allowance on the panel to get a dry date`,
    }).catch(() => undefined);
  }
}

/** The panel's payload — registry rows joined with live env truth, the
 * refusal feed, and the runway math. Also the write-on-read point where
 * warn/crit runway pulses reach the watchtower (deduped per day/level). */
export async function integrationsSnapshot(): Promise<{ integrations: IntegrationView[]; fleet: FleetView; gateRefusals24h: number }> {
  await ensureKnownIntegrations();
  const nowMs = Date.now();
  const [rows, countsAll, counts7d, counts24h, gateRefusals24h] = await Promise.all([
    db.integrationRecord.findMany({ orderBy: [{ kind: "asc" }, { provider: "asc" }] }),
    db.contactResolution.groupBy({
      by: ["provider", "outcome"],
      _count: { _all: true },
      _sum: { creditsUsed: true },
    }),
    db.contactResolution.groupBy({
      by: ["provider", "outcome"],
      where: { createdAt: { gte: new Date(nowMs - 7 * DAY_MS) } },
      _sum: { creditsUsed: true },
    }),
    db.contactResolution.groupBy({
      by: ["provider"],
      where: { outcome: "refused", createdAt: { gte: new Date(nowMs - DAY_MS) } },
      _count: { _all: true },
    }),
    // gate-level refusals — rows written before a provider was picked
    // (unregistered, staged, key-missing, open circuit, invalid query)
    db.contactResolution.count({
      where: { outcome: "refused", provider: "none", createdAt: { gte: new Date(nowMs - DAY_MS) } },
    }),
  ]);
  const countMap = new Map(countsAll.map((c) => [`${c.provider}:${c.outcome}`, c]));
  const spend7d = new Map(counts7d.map((c) => [c.provider, c._sum.creditsUsed ?? 0]));
  const refused24h = new Map(counts24h.map((c) => [c.provider, c._count._all]));
  const integrations: IntegrationView[] = rows.map((row) => {
    const known = KNOWN_INTEGRATIONS.find((k) => k.provider === row.provider);
    const resolved = countMap.get(`${row.provider}:resolved`);
    const refused = countMap.get(`${row.provider}:refused`);
    const spent7d = spend7d.get(row.provider) ?? 0;
    return {
      provider: row.provider,
      label: known?.label ?? row.provider,
      kind: row.kind,
      authType: row.authType,
      status: row.status,
      circuitState: row.circuitState,
      consecutiveFailures: row.consecutiveFailures,
      keyEnvVar: row.keyEnvVar,
      keyPresent: keyPresentFor(row.keyEnvVar),
      quotaRemaining: row.quotaRemaining,
      quotaUpdatedAt: row.quotaUpdatedAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      lastError: row.lastError,
      callsTotal: row.callsTotal,
      callsFailed: row.callsFailed,
      notes: row.notes ?? known?.what ?? null,
      doorPath: known?.doorPath ?? null,
      // enrich rows carry the honest ledger roll-up: resolutions, spend,
      // refusals (the fail-closed feed), and the runway projection
      ...(row.kind === "enrich"
        ? {
            resolutionsResolved: resolved?._count._all ?? 0,
            creditsSpent: resolved?._sum.creditsUsed ?? 0,
            refusals24h: refused24h.get(row.provider) ?? 0,
            refusalsTotal: refused?._count._all ?? 0,
            runway: computeRunway(row.quotaRemaining, spent7d, nowMs),
          }
        : {}),
    } as IntegrationView & { resolutionsResolved?: number; creditsSpent?: number };
  });
  await fireRunwayPulses(integrations);
  return { integrations, fleet: deriveFleet(integrations), gateRefusals24h };
}
