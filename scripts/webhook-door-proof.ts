/**
 * Tier-1 connection proof — exercises the three machine mail doors over the
 * running dev server, exactly as Resend (or any relay) would drive them:
 *
 *   /api/mail/inbound               canonical relay envelope (HMAC door)
 *   /api/providers/resend/events    delivery feedback (Svix door)
 *   /api/providers/resend/inbound   signature rejection path only — the
 *                                   happy path needs a live RESEND_API_KEY
 *                                   to fetch bodies, so it stays honest here
 *
 * Creates two scratch prospects + dispatches, drives every event, asserts
 * every ledger effect (InboundReply, AgentDraft, SuppressionRecord, Dispatch
 * transitions, EnginePulse dedupe), then cleans every proof row up.
 * Run against a live server:  bun scripts/webhook-door-proof.ts
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const base = process.env.BASE_URL ?? "http://localhost:3000";

const env = readFileSync(".env", "utf8");
const inSecret = env.match(/^INBOUND_MAIL_SECRET=(.+)$/m)?.[1]?.trim();
const whsec = env.match(/^RESEND_WEBHOOK_SECRET=(.+)$/m)?.[1]?.trim();
if (!inSecret || !whsec) throw new Error("INBOUND_MAIL_SECRET / RESEND_WEBHOOK_SECRET missing from .env");

// ---- signing helpers (same schemes the doors verify) ---------------------- //

function hmacSign(body: string): string {
  return createHmac("sha256", inSecret!).update(body).digest("hex");
}
// mirror unwrapSvixSecret exactly: whsec_ → base64 payload, bare → raw utf8
const svixKey = whsec!.startsWith("whsec_")
  ? Buffer.from(whsec!.slice("whsec_".length), "base64")
  : Buffer.from(whsec!, "utf8");
function svixSign(body: string, id: string, tsSec: number): string {
  return createHmac("sha256", svixKey).update(`${id}.${tsSec}.${body}`, "utf8").digest("base64");
}

// ---- proof data ----------------------------------------------------------- //

const run = Date.now().toString(36);
const PROOF_A = {
  name: "Webhook Proof One",
  domain: "proof-one.test",
  bestEmail: `vera@proof-one.test`,
  dispatchMsgIds: { delivered: `resend-proof-dlv-${run}`, opened: `resend-proof-opn-${run}`, bounce: `resend-proof-bnc-${run}` },
};
const PROOF_B = {
  name: "Webhook Proof Two",
  domain: "proof-two.test",
  bestEmail: `ruth@proof-two.test`,
  dispatchMsgIds: { complaint: `resend-proof-cmp-${run}` },
};
const svixId = (what: string) => `msg_proof_${run}_${what}`;

let failures = 0;
interface ProofJson {
  ok?: boolean;
  duplicate?: boolean;
  matched?: boolean;
  matchedVia?: string;
  replyId?: string;
  intent?: string;
  tier?: number;
  action?: string;
  draft?: { id?: string } | null;
  ignored?: boolean;
  dispatch?: { from?: string; to?: string } | null;
  suppressed?: boolean;
  note?: string;
}
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

/**
 * The ledger keeps only real business rows: every proof artefact — this
 * run's AND any left behind by a killed earlier run — is swept first and
 * last. Proof prospects carry the console://webhook-proof- sourceUrl.
 */
async function cleanupProofRows() {
  const stale = await db.prospect.findMany({
    where: { sourceUrl: { startsWith: "console://webhook-proof-" } },
    select: { id: true, bestEmail: true },
  });
  const emails = stale.map((p) => p.bestEmail).filter((e): e is string => Boolean(e));
  await db.inboundReply.deleteMany({
    where: { OR: [{ fromEmail: { in: emails } }, { fromEmail: { contains: "@nowhere-" } }] },
  });
  await db.suppressionRecord.deleteMany({ where: { email: { in: emails } } });
  await db.prospect.deleteMany({ where: { id: { in: stale.map((p) => p.id) } } });
  await db.enginePulse.deleteMany({
    where: {
      engineId: { in: ["mail-relay", "resend-events"] },
      OR: [{ pulseRef: { startsWith: "msg_proof_" } }, { pulseRef: { contains: "proof-env-" } }, { pulseRef: { contains: "proof-unknown-" } }],
    },
  });
}

async function post(path: string, body: string, headers: Record<string, string>) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    // cold-compile of a route on first hit can be slow; 25s is the ceiling
    signal: AbortSignal.timeout(25_000),
  });
  let json: ProofJson = {};
  try { json = await res.json() as ProofJson; } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function main() {
  console.log(`\n=== Tier-1 door proof (run ${run}) ===`);

  // ---- sweep any leftovers from earlier killed runs, then set up ---------- //
  await cleanupProofRows();
  // ---- setup: scratch prospects + dispatches ------------------------------ //
  const pa = await db.prospect.create({
    data: {
      source: "console", sourceUrl: `console://webhook-proof-${run}`, name: PROOF_A.name,
      domainKey: `proof-one-${run}`, domain: PROOF_A.domain, bestEmail: PROOF_A.bestEmail, ingestion: "ingested",
      dispatches: {
        create: [
          { channel: "channel_a_automated_email", status: "sent", providerMsgId: PROOF_A.dispatchMsgIds.delivered, subject: "proof dlv", body: "proof" },
          { channel: "channel_a_automated_email", status: "sent", providerMsgId: PROOF_A.dispatchMsgIds.opened, subject: "proof opn", body: "proof" },
          { channel: "channel_a_automated_email", status: "sent", providerMsgId: PROOF_A.dispatchMsgIds.bounce, subject: "proof bnc", body: "proof" },
        ],
      },
    },
  });
  const pb = await db.prospect.create({
    data: {
      source: "console", sourceUrl: `console://webhook-proof-${run}`, name: PROOF_B.name,
      domainKey: `proof-two-${run}`, domain: PROOF_B.domain, bestEmail: PROOF_B.bestEmail, ingestion: "ingested",
      dispatches: { create: [{ channel: "channel_a_automated_email", status: "sent", providerMsgId: PROOF_B.dispatchMsgIds.complaint, subject: "proof cmp", body: "proof" }] },
    },
  });

  try {
    // ================= DOOR A — canonical relay envelope ==================== //
    console.log("\n[A] /api/mail/inbound — canonical relay envelope (HMAC door)");

    const envelope = JSON.stringify({
      from: `Vera Proof <${PROOF_A.bestEmail}>`,
      subject: "We'd like to proceed with a call next week",
      text: "Josias — good pitch. We should proceed and set up a call with our ops team next week.",
      messageId: `proof-env-${run}@proof-one.test`,
      receivedAt: new Date().toISOString(),
    });

    const unsigned = await post("/api/mail/inbound", envelope, {});
    check("unsigned envelope refused (401)", unsigned.status === 401, unsigned);

    const tampered = await post("/api/mail/inbound", envelope, { "x-vertebra-signature": hmacSign(envelope.replace("proceed", "pause")) });
    check("tampered body refused (401)", tampered.status === 401, tampered);

    const signed = await post("/api/mail/inbound", envelope, { "x-vertebra-signature": hmacSign(envelope) });
    check("signed envelope accepted, matched via best_email", signed.status === 200 && signed.json.matched === true && signed.json.matchedVia === "best_email", signed);
    check("reply classified + tiered", typeof signed.json.intent === "string" && (signed.json.tier === 1 || signed.json.tier === 2), signed.json);

    const retry = await post("/api/mail/inbound", envelope, { "x-vertebra-signature": hmacSign(envelope) });
    check("same messageId retried → duplicate absorbed", retry.status === 200 && retry.json.duplicate === true, retry);

    const stranger = JSON.stringify({
      from: `Stranger <stranger@nowhere-${run}.test>`,
      subject: "What is this?",
      text: "Hello? Who are you people.",
      messageId: `proof-unknown-${run}@nowhere.test`,
    });
    const unmatched = await post("/api/mail/inbound", stranger, { "x-vertebra-signature": hmacSign(stranger) });
    check("unmatched sender recorded honestly (202, matched:false)", unmatched.status === 202 && unmatched.json.matched === false && typeof unmatched.json.replyId === "string", unmatched);

    const aReplies = await db.inboundReply.count({ where: { fromEmail: { in: [PROOF_A.bestEmail, `stranger@nowhere-${run}.test`] } } });
    check("InboundReply rows in ledger (matched + unmatched)", aReplies === 2, { aReplies });
    const draft = signed.json.draft;
    if (signed.json.tier === 2 && draft?.id) {
      const d = await db.agentDraft.findUnique({ where: { id: draft.id } });
      check("tier-2 draft parked for human review", d?.status === "pending_human_review", d?.status);
    }

    // ================= DOOR C — Resend delivery events ====================== //
    console.log("\n[C] /api/providers/resend/events — delivery feedback (Svix door)");

    function eventBody(type: string, emailId: string, to: string, bounce?: { type: string; message: string }) {
      return JSON.stringify({
        type,
        created_at: new Date().toISOString(),
        data: { email_id: emailId, to: [to], ...(bounce ? { bounce } : {}) },
      });
    }
    async function postEvent(what: string, body: string) {
      const ts = Math.floor(Date.now() / 1000);
      return post("/api/providers/resend/events", body, {
        "svix-id": svixId(what),
        "svix-timestamp": String(ts),
        "svix-signature": `v1,${svixSign(body, svixId(what), ts)}`,
      });
    }

    const badSig = await post("/api/providers/resend/events", eventBody("email.delivered", "x", "y"), {
      "svix-id": svixId("badsig"), "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,AAAA",
    });
    check("bad signature refused (401)", badSig.status === 401, badSig);

    const clicked = await postEvent("clicked", eventBody("email.clicked", "whatever", "x"));
    check("unknown event acknowledged + ignored", clicked.status === 200 && clicked.json.ignored === true, clicked);

    const dlv = await postEvent("dlv", eventBody("email.delivered", PROOF_A.dispatchMsgIds.delivered, PROOF_A.bestEmail));
    check("email.delivered → dispatch delivered", dlv.status === 200 && dlv.json.dispatch?.to === "delivered", dlv);

    const opn = await postEvent("opn", eventBody("email.opened", PROOF_A.dispatchMsgIds.opened, PROOF_A.bestEmail));
    check("email.opened → dispatch opened", opn.status === 200 && opn.json.dispatch?.to === "opened", opn);
    const openedRow = await db.dispatch.findFirst({ where: { providerMsgId: PROOF_A.dispatchMsgIds.opened }, select: { status: true } });
    check("opened transition visible in ledger", openedRow?.status === "opened", openedRow);

    const bnc = await postEvent("bnc", eventBody("email.bounced", PROOF_A.dispatchMsgIds.bounce, PROOF_A.bestEmail, {
      type: "Permanent", message: "smtp 550 mailbox unavailable",
    }));
    check("hard bounce → dispatch failed + suppressed", bnc.status === 200 && bnc.json.dispatch?.to === "failed" && bnc.json.suppressed === true, bnc);

    const bncRetry = await postEvent("bnc", eventBody("email.bounced", PROOF_A.dispatchMsgIds.bounce, PROOF_A.bestEmail, {
      type: "Permanent", message: "smtp 550 mailbox unavailable",
    }));
    check("same svix-id retried → duplicate absorbed", bncRetry.status === 200 && bncRetry.json.duplicate === true, bncRetry);

    const cmp = await postEvent("cmp", eventBody("email.complained", PROOF_B.dispatchMsgIds.complaint, PROOF_B.bestEmail));
    check("complaint → dispatch stopped + suppressed", cmp.status === 200 && cmp.json.dispatch?.to === "stopped" && cmp.json.suppressed === true, cmp);

    // ---- ledger effects ----------------------------------------------------- //
    const statuses = await db.dispatch.findMany({
      where: { providerMsgId: { in: Object.values(PROOF_A.dispatchMsgIds).concat(Object.values(PROOF_B.dispatchMsgIds)) } },
      select: { providerMsgId: true, status: true, error: true },
    });
    const byId = new Map(statuses.map((d) => [d.providerMsgId, d]));
    check("delivered dispatch untouched by the bounce", byId.get(PROOF_A.dispatchMsgIds.delivered)?.status === "delivered", byId.get(PROOF_A.dispatchMsgIds.delivered));
    check("opened dispatch stopped by the bounce (dead address stops the sequence)", byId.get(PROOF_A.dispatchMsgIds.opened)?.status === "stopped" && (byId.get(PROOF_A.dispatchMsgIds.opened)?.error ?? "").includes("hard bounce"), byId.get(PROOF_A.dispatchMsgIds.opened));
    check("dispatch failed with bounce message", byId.get(PROOF_A.dispatchMsgIds.bounce)?.status === "failed" && (byId.get(PROOF_A.dispatchMsgIds.bounce)?.error ?? "").includes("550"), byId.get(PROOF_A.dispatchMsgIds.bounce));
    check("dispatch stopped on complaint", byId.get(PROOF_B.dispatchMsgIds.complaint)?.status === "stopped", byId.get(PROOF_B.dispatchMsgIds.complaint));

    const suppressions = await db.suppressionRecord.findMany({
      where: { email: { in: [PROOF_A.bestEmail, PROOF_B.bestEmail] } },
    });
    check("hard bounce suppression recorded (reason bounce)", suppressions.some((s) => s.email === PROOF_A.bestEmail && s.reason === "bounce" && s.source === "engine"), suppressions);
    check("complaint suppression recorded (reason complaint)", suppressions.some((s) => s.email === PROOF_B.bestEmail && s.reason === "complaint"), suppressions);

    const stoppedAfterBounce = await db.dispatch.count({
      where: { prospectId: pa.id, channel: "channel_a_automated_email", status: "stopped" },
    });
    check("hard bounce stopped exactly the active sequence step(s)", stoppedAfterBounce === 1, { stoppedAfterBounce });

    const pulses = await db.enginePulse.count({
      where: { engineId: { in: ["mail-relay", "resend-events"] }, pulseRef: { contains: run } },
    });
    check("watchtower pulses written (visibility + dedupe ledger)", pulses >= 6, { pulses });

    // ================= DOOR B — Resend native inbound ======================= //
    console.log("\n[B] /api/providers/resend/inbound — signature rejection path only");

    const rb = eventBody("email.received", "email-id-x", PROOF_A.bestEmail);
    const bUnsigned = await post("/api/providers/resend/inbound", rb, {});
    check("unsigned inbound refused (401)", bUnsigned.status === 401, bUnsigned);
    const ts = Math.floor(Date.now() / 1000);
    const bBad = await post("/api/providers/resend/inbound", rb, {
      "svix-id": svixId("bin"), "svix-timestamp": String(ts), "svix-signature": `v1,${svixSign(rb, "wrong-id", ts)}`,
    });
    check("wrong-id signature refused (401)", bBad.status === 401, bBad);
    console.log("  ℹ happy path needs a live RESEND_API_KEY (body fetch) — full drive happens on the real wire");

    console.log(failures === 0 ? "\nTIER-1 DOOR PROOF: PASS\n" : `\nTIER-1 DOOR PROOF: FAIL (${failures} failing)\n`);
  } finally {
    // ---- cleanup: the ledger keeps only real business rows ----------------- //
    await cleanupProofRows();
    await db.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("proof crashed:", e);
  await db.$disconnect();
  process.exit(1);
});
