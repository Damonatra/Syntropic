/**
 * Egress-gate proof — interlock 3 exercised end to end, no server needed.
 *
 * Imports the real mailer, points it at the real SQLite ledger, and walks
 * every verdict the warmup gate can return:
 *
 *   unregistered            → refused (the ledger is the allowlist)
 *   dnsStatus=pending       → refused (the provider would 401 it anyway)
 *   spare (warmup not set)  → refused
 *   warming, cap 5, 5 sent  → refused (the ramp is the reputation)
 *   warming, 4 sent         → passes the gate, dies at Resend with 401
 *                             (fake key — the gate did its job, the provider
 *                              never sees a real send from a proof run)
 *   paused / burned         → refused
 *   transactional + verified→ passes the gate (no ramp on operator mail)
 *
 * Scratch rows (one prospect, six dispatches, one ledger row) are cleaned up.
 * Run:  SYNTROPIC_UNSUBSCRIBE_SECRET=proof-custom-secret RESEND_API_KEY=re_proof_placeholder \
 *       ENCLAVE_EGRESS_ARMED=1 bun scripts/domain-gate-proof.ts
 */
import { PrismaClient } from "@prisma/client";
import { sendEmail } from "../src/lib/vertebra/mailer";

// Interlock env — the gate only bites under live egress, so arm it honestly
// with a placeholder key: sends that pass the gate must fail at the provider,
// never leave the building. Set BEFORE the mailer functions run (they read
// env at call time), which is exactly what a live enclave would carry.
process.env.RESEND_API_KEY = "re_proof_placeholder";
process.env.ENCLAVE_EGRESS_ARMED = "1";
process.env.SYNTROPIC_UNSUBSCRIBE_SECRET = "proof-custom-secret";

const db = new PrismaClient();
const DOMAIN = "proof-warm.vertebra-test.com";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ·  ${detail}` : ""}`);
}

async function main() {
  const prospect = await db.prospect.create({
    data: { name: "Egress Gate Proof Co", domainKey: `proof:${Date.now()}`, bestEmail: "ops@proof.local" },
  });

  // Clean slate for the proof domain, then register it — pending DNS.
  await db.sendingDomain.deleteMany({ where: { domain: DOMAIN } });
  await db.sendingDomain.create({ data: { domain: DOMAIN, role: "sending" } });
  await db.dispatch.deleteMany({ where: { fromDomain: DOMAIN } });

  const send = (overrides: Record<string, unknown> = {}) =>
    sendEmail({
      to: "ops@proof.local",
      subject: "egress gate proof",
      text: "proof run — never leaves the building",
      prospectId: prospect.id,
      fromDomain: DOMAIN,
      ...overrides,
    });

  // 1 — unregistered domain
  const ghost = await sendEmail({ to: "ops@proof.local", subject: "x", text: "x", fromDomain: "ghost.example.com" });
  check("unregistered domain refused", ghost.status === "failed" && (ghost.reason ?? "").includes("unregistered_sending_domain"), ghost.reason);

  // 2 — registered but DNS pending
  const pending = await send();
  check("dns pending refused", pending.status === "failed" && (pending.reason ?? "").includes("domain_dns_unverified"), pending.reason);

  // 3 — DNS verified but warmup never started (spare)
  await db.sendingDomain.update({ where: { domain: DOMAIN }, data: { dnsStatus: "verified" } });
  const spare = await send();
  check("spare refused (warmup not started)", spare.status === "failed" && (spare.reason ?? "").includes("domain_warmup_not_started"), spare.reason);

  // 4 — warming day 1, cap 5, five sent today → the 6th refuses
  await db.sendingDomain.update({ where: { domain: DOMAIN }, data: { status: "warming", warmupStartedAt: new Date() } });
  for (let i = 0; i < 5; i += 1) {
    await db.dispatch.create({
      data: { prospectId: prospect.id, channel: "channel_a_automated_email", status: "sent", fromDomain: DOMAIN, subject: "cap filler" },
    });
  }
  const capped = await send();
  check("warmup cap reached refused", capped.status === "failed" && (capped.reason ?? "").includes("warmup_cap_reached"), capped.reason);

  // 5 — under the cap the gate passes it through to the provider (401 on the proof key)
  await db.dispatch.deleteMany({ where: { fromDomain: DOMAIN, subject: "cap filler" } });
  const passed = await send();
  check("under cap → passes gate, provider 401 (proof key)", passed.status === "failed" && (passed.reason ?? "").startsWith("resend_4"), passed.reason);

  // 6 — paused refuses even under cap
  await db.sendingDomain.update({ where: { domain: DOMAIN }, data: { status: "paused" } });
  const paused = await send();
  check("paused refused", paused.status === "failed" && (paused.reason ?? "").includes("domain_paused"), paused.reason);

  // 7 — burned refuses
  await db.sendingDomain.update({ where: { domain: DOMAIN }, data: { status: "burned" } });
  const burned = await send();
  check("burned refused", burned.status === "failed" && (burned.reason ?? "").includes("domain_burned"), burned.reason);

  // 8 — transactional role skips the ramp, keeps the DNS requirement
  await db.sendingDomain.update({ where: { domain: DOMAIN }, data: { role: "transactional", status: "spare", warmupStartedAt: null } });
  const tx = await send();
  check("transactional passes (verified dns)", tx.status === "failed" && (tx.reason ?? "").startsWith("resend_4"), tx.reason);

  // cleanup — every proof row
  await db.dispatch.deleteMany({ where: { fromDomain: DOMAIN } });
  await db.sendingDomain.deleteMany({ where: { domain: DOMAIN } });
  await db.prospect.delete({ where: { id: prospect.id } });

  console.log(failures === 0 ? "\nEGRESS GATE PROOF: 8/8 verdicts correct" : `\nEGRESS GATE PROOF: ${failures} failure(s)`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("proof crashed:", e);
  await db.$disconnect();
  process.exit(1);
});
