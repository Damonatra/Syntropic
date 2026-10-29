/**
 * E2E loop-closure smoke: due dispatch → honest backoff → unsubscribe → stopped.
 * Run: bun run scripts/smoke_loop_closure.ts
 */
import { createHmac } from "node:crypto";

const BASE = "http://127.0.0.1:3000";
const KEY = process.env.VERTEBRA_INGEST_KEY ?? "enclave-dev-key";

async function j(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-vertebra-key": KEY, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

// 1. Pick a CASL-scope prospect with a verified email (or fall back to any scored lead).
const snap = (await j("GET", "/api/command")).data as { leads: Array<{ id: string; name: string; bestEmail: string | null; caslScope: boolean }> };
const lead = snap.leads.find((l) => l.bestEmail) ?? snap.leads[0];
if (!lead) throw new Error("no leads");
console.log(`[1] target: ${lead.name} · ${lead.bestEmail}`);

// 2. Plant a due dispatch directly in the store (console mirrors engine writes).
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const dispatch = await db.dispatch.create({
  data: {
    prospectId: lead.id,
    channel: "channel_a_automated_email",
    status: "queued",
    caslScope: lead.caslScope,
    scheduledAt: new Date(Date.now() - 60_000),
    subject: `Smoke: ${lead.name} quoting benchmark`,
  },
});
console.log(`[2] planted due dispatch ${dispatch.id}`);

// 3. Tick without a provider → honest defer + backoff (never fake-sent).
let tick = (await j("POST", "/api/cron/tick")).data as { deferred: number; details: Array<{ outcome: string; note?: string }> };
console.log(`[3] tick#1 → deferred=${tick.deferred} · ${tick.details[0]?.note ?? ""}`);
const after1 = await db.dispatch.findUnique({ where: { id: dispatch.id } });
console.log(`    status=${after1?.status} · error=${after1?.error}`);

// 4. Unsubscribe with a valid HMAC token (same derivation as casl.ts).
const secret = process.env.SYNTROPIC_UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret-rotate-in-prod";
const token = createHmac("sha256", secret).update(`${lead.id}:${lead.bestEmail}`).digest("hex").slice(0, 32);
const unsub = await j("POST", `/api/unsubscribe?p=${lead.id}&a=${encodeURIComponent(lead.bestEmail!)}&t=${token}`);
console.log(`[4] one-click unsubscribe → ${unsub.status} ${JSON.stringify(unsub.data)}`);

// 5. Suppression refuses draft sends + tick stops further contact.
const suppression = await db.suppressionRecord.findUnique({ where: { email: lead.bestEmail!.toLowerCase() } });
console.log(`[5] suppression row: ${suppression ? `${suppression.reason}/${suppression.source}` : "MISSING"}`);

// 6. Plant another due dispatch → tick must stop it (suppression wins).
await db.dispatch.create({
  data: {
    prospectId: lead.id,
    channel: "channel_a_automated_email",
    status: "queued",
    scheduledAt: new Date(Date.now() - 60_000),
    subject: "should never send",
  },
});
tick = (await j("POST", "/api/cron/tick")).data as { stopped: number; details: Array<{ outcome: string }> };
console.log(`[6] tick#2 → stopped=${tick.stopped} · ${tick.details[0]?.outcome ?? ""}`);

// 7. Alert ack round-trip.
const alerts = (await j("GET", "/api/command")).data as { alerts: Array<{ id: string; acknowledgedAtMs: number | null }> };
const unacked = alerts.alerts.find((a) => a.acknowledgedAtMs == null);
if (unacked) {
  const ack = await j("POST", "/api/alerts/ack", { alertIds: [unacked.id] });
  const after = (await j("GET", "/api/command")).data as { alerts: Array<{ id: string; acknowledgedAtMs: number | null }> };
  const nowAcked = after.alerts.find((a) => a.id === unacked.id);
  console.log(`[7] ack ${unacked.id.slice(0, 8)} → count=${ack.data?.acknowledged} · persisted=${nowAcked?.acknowledgedAtMs != null}`);
} else {
  console.log("[7] no unacked alerts on file (all previously acked) — ok");
}

// 8. Gate disabled sanity.
const gate = await j("POST", "/api/gate", { password: "whatever" });
console.log(`[8] gate (disabled mode) → ${gate.status} gated=${gate.data?.gated}`);

await db.dispatch.deleteMany({ where: { prospectId: lead.id, subject: { in: [`Smoke: ${lead.name} quoting benchmark`, "should never send"] } } });
console.log("[9] smoke dispatches cleaned up");
await db.$disconnect();
