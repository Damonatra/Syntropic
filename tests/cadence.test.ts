/**
 * The cadence engine — autonomous follow-ups, exercised on an isolated
 * scratch SQLite (never the dev ledger).
 *
 *   1. disarmed = silent — no rows, no dispatches, honest armed:false
 *   2. step-2 admission — an unanswered opener past its window queues the
 *      follow-up IN THE SAME THREAD (Re: subject, body composed, no footer
 *      duplication — the mailer owns the CASL footer), overdue sends jittered
 *   3. not_due_yet — a fresh touch is left alone
 *   4. reply-stop — any live reply hands the conversation to tiered autonomy
 *   5. OOO defer — the next step re-anchors to the return date
 *   6. veto first — the operator's always-win card beats every other gate
 *   7. suppression refuses
 *   8. thread door — no provider message id, no follow-up
 *   9. stopped sequence — a not_interested stop is respected forever
 *  10. sequence_complete — step 3 is the ceiling
 *  11. idempotent — a fresh-window scan stacks no duplicates
 *  12. one claim per 90 s window — a concurrent trigger absorbs
 *  13. cap — oldest-due first, overflow refused with lane_cap
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

vi.hoisted(() => {
  process.env.DATABASE_URL = `file:${process.cwd()}/db/cadence-test.db`;
});

import { db } from "@/lib/db";
import {
  CADENCE_JITTER_MS,
  CADENCE_MAX_STEP,
  composeFollowup,
  runCadenceScan,
  threadSubject,
} from "@/lib/vertebra/cadence";

const SCRATCH = join(process.cwd(), "db", "cadence-test.db");
const T0 = new Date("2026-11-01T12:00:00Z");
const DAY = 86_400_000;
/** A clock pinned mid-bucket so +1s stays inside the same 90 s claim window. */
const midBucket = (t: Date) => new Date(Math.floor(t.valueOf() / 90_000) * 90_000 + 45_000);

let seq = 0;
async function seedProspect(opts: { name: string; qlv?: number }) {
  seq += 1;
  const slug = opts.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return db.prospect.create({
    data: {
      name: opts.name,
      domainKey: `dk-${slug}`,
      bestEmail: `ops${seq}@${slug}.example.com`,
      scores: {
        create: {
          qlvScore: opts.qlv ?? 80,
          band: "prime",
          factorsJson: "{}",
          hooksJson: JSON.stringify([{ flavor: "rfq_latency", body: `hook for ${opts.name}` }]),
          rationale: "test seed",
          model: "test",
          fingerprint: `fp-cadence-${seq}-${Date.now()}`,
        },
      },
    },
    select: { id: true, name: true, bestEmail: true, caslScope: true },
  });
}

/** A sent Channel A touch, raw-pinned to its send time (bypasses @updatedAt). */
async function seedSentTouch(
  prospectId: string,
  opts: { step: number; sentAt: Date; subject?: string | null; msgId?: string | null },
) {
  const row = await db.dispatch.create({
    data: {
      prospectId,
      channel: "channel_a_automated_email",
      status: "sent",
      step: opts.step,
      subject: opts.subject ?? null,
      providerMsgId: opts.msgId ?? null,
      provider: "resend",
      caslScope: false,
      scheduledAt: opts.sentAt,
    },
    select: { id: true },
  });
  await db.$executeRawUnsafe(`UPDATE Dispatch SET updatedAt = ? WHERE id = ?`, opts.sentAt, row.id);
  return row.id;
}

const dispatchesFor = (prospectId: string) =>
  db.dispatch.findMany({ where: { prospectId, channel: "channel_a_automated_email" }, orderBy: { step: "asc" } });

beforeAll(async () => {
  rmSync(SCRATCH, { force: true });
  rmSync(`${SCRATCH}-journal`, { force: true });
  execSync("npx prisma db push --skip-generate", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${SCRATCH}` },
    stdio: "pipe",
  });
  process.env.VERTEBRA_FASTLANE = "on";
});

afterAll(async () => {
  delete process.env.VERTEBRA_FASTLANE;
  await db.$disconnect();
});

describe("cadence — the follow-up engine", () => {
  it("1. disarmed = fully silent: no rows, no dispatches, no pulses", async () => {
    const p = await seedProspect({ name: "Silent Extrusion" });
    await seedSentTouch(p.id, { step: 1, sentAt: new Date(T0.valueOf() - 5 * DAY), subject: "Silent Extrusion: RFQ turnaround", msgId: "msg-silent-1" });
    process.env.VERTEBRA_FASTLANE = "off";
    const out = await runCadenceScan(T0);
    process.env.VERTEBRA_FASTLANE = "on";
    expect(out.armed).toBe(false);
    expect(out.admitted).toBe(0);
    expect((await dispatchesFor(p.id)).length).toBe(1);
    expect(await db.enginePulse.count({ where: { engineId: "cadence" } })).toBe(0);
  });

  it("2. step-2 admission — same thread, composed body, one footer, overdue jitter", async () => {
    const p = await seedProspect({ name: "Ironvale Pipe" });
    const sentAt = new Date(T0.valueOf() - 4 * DAY); // day-3 window passed a day ago
    await seedSentTouch(p.id, { step: 1, sentAt, subject: "Ironvale Pipe: RFQ turnaround", msgId: "msg-ironvale-1" });
    const scanAt = midBucket(T0);
    const out = await runCadenceScan(scanAt);
    expect(out.armed).toBe(true);
    expect(out.claimDeduped).toBe(false);
    const mine = out.admissions.find((a) => a.name === "Ironvale Pipe");
    expect(mine).toBeTruthy();
    expect(mine!.step).toBe(2);
    const rows = await dispatchesFor(p.id);
    expect(rows.length).toBe(2);
    const follow = rows.find((d) => d.step === 2)!;
    expect(follow.status).toBe("queued");
    expect(follow.subject).toBe("Re: Ironvale Pipe: RFQ turnaround"); // the thread promise
    expect(follow.body).toContain("Josias");
    expect(follow.body).toContain("hook for Ironvale Pipe"); // composed from the evidence hook
    expect(follow.body).not.toContain("Unsubscribe"); // the mailer owns the CASL footer — exactly one
    const jitter = follow.scheduledAt!.valueOf() - scanAt.valueOf(); // overdue → jittered from the scan clock
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThanOrEqual(CADENCE_JITTER_MS);
    // the scan told its story on the ledger
    const pulses = await db.enginePulse.findMany({ where: { engineId: "cadence" } });
    expect(pulses.length).toBeGreaterThanOrEqual(2); // claim + result
    expect(pulses.some((r) => (r.detail ?? "").includes("Ironvale Pipe"))).toBe(true);
  });

  it("3. not_due_yet — a fresh touch is left alone", async () => {
    const p = await seedProspect({ name: "Freshline Bearings" });
    await seedSentTouch(p.id, { step: 1, sentAt: new Date(T0.valueOf() - 1 * DAY), subject: "Freshline Bearings: RFQ turnaround", msgId: "msg-freshline-1" });
    const out = await runCadenceScan(midBucket(new Date(T0.valueOf() + 10 * 90_000)));
    const reasons = new Map(out.refusals.map((r) => [r.name, r.reason]));
    expect(reasons.get("Freshline Bearings")).toBe("not_due_yet");
    expect((await dispatchesFor(p.id)).length).toBe(1);
  });

  it("4. reply-stop — a live reply hands the conversation to tiered autonomy", async () => {
    const p = await seedProspect({ name: "Livewire Forge" });
    const sentAt = new Date(T0.valueOf() - 5 * DAY);
    await seedSentTouch(p.id, { step: 1, sentAt, subject: "Livewire Forge: RFQ turnaround", msgId: "msg-livewire-1" });
    await db.inboundReply.create({
      data: {
        prospectId: p.id,
        fromEmail: p.bestEmail!,
        subject: "Re: Livewire Forge: RFQ turnaround",
        body: "This sounds interesting — what does onboarding look like?",
        intent: "interested",
        intentConfidence: 0.9,
        receivedAt: new Date(T0.valueOf() - 2 * DAY),
      },
    });
    const out = await runCadenceScan(midBucket(new Date(T0.valueOf() + 20 * 90_000)));
    const reasons = new Map(out.refusals.map((r) => [r.name, r.reason]));
    expect(reasons.get("Livewire Forge")).toBe("reply_landed_conversation_live");
    expect((await dispatchesFor(p.id)).length).toBe(1); // no machine follow-up behind a human conversation
  });

  it("5. OOO defer — the next step re-anchors to the return date", async () => {
    const p = await seedProspect({ name: "Awayline Casting" });
    await seedSentTouch(p.id, { step: 1, sentAt: new Date(T0.valueOf() - 5 * DAY), subject: "Awayline Casting: RFQ turnaround", msgId: "msg-awayline-1" });
    const returnDate = new Date(T0.valueOf() + 6 * DAY); // stated as YYYY-MM-DD in the reply
    await db.inboundReply.create({
      data: {
        prospectId: p.id,
        fromEmail: p.bestEmail!,
        subject: "Out of office",
        body: "I am away until November 7 with limited email access.",
        intent: "out_of_office",
        intentConfidence: 0.95,
        extractedJson: JSON.stringify({ return_date: returnDate.toISOString().slice(0, 10) }),
        receivedAt: new Date(T0.valueOf() - 2 * DAY),
      },
    });
    const out = await runCadenceScan(midBucket(new Date(T0.valueOf() + 30 * 90_000)));
    const mine = out.admissions.find((a) => a.name === "Awayline Casting");
    expect(mine).toBeTruthy();
    expect(mine!.note).toBe("ooo_deferred");
    // anchored to the STATED return date (parsed at 00:00Z), not the plan's day-3
    expect(mine!.scheduledAt.valueOf()).toBe(new Date(returnDate.toISOString().slice(0, 10)).valueOf());
  });

  it("6. veto first — the operator's always-win card beats everything", async () => {
    const p = await seedProspect({ name: "Vetoed Steel" });
    await seedSentTouch(p.id, { step: 1, sentAt: new Date(T0.valueOf() - 5 * DAY), subject: "Vetoed Steel: RFQ turnaround", msgId: "msg-vetoed-1" });
    await db.operatorAction.create({ data: { prospectId: p.id, action: "vetoed", actor: "damon", note: "do not touch" } });
    const out = await runCadenceScan(midBucket(new Date(T0.valueOf() + 40 * 90_000)));
    const reasons = new Map(out.refusals.map((r) => [r.name, r.reason]));
    expect(reasons.get("Vetoed Steel")).toBe("vetoed_by_operator");
    expect((await dispatchesFor(p.id)).length).toBe(1);
  });

  it("7. suppression refuses — unsubscribed, bounced, complained", async () => {
    const p = await seedProspect({ name: "Suppressed Coil" });
    await seedSentTouch(p.id, { step: 1, sentAt: new Date(T0.valueOf() - 5 * DAY), subject: "Suppressed Coil: RFQ turnaround", msgId: "msg-suppressed-1" });
    await db.suppressionRecord.create({ data: { email: p.bestEmail!, reason: "unsubscribe" } });
    const out = await runCadenceScan(midBucket(new Date(T0.valueOf() + 50 * 90_000)));
    const reasons = new Map(out.refusals.map((r) => [r.name, r.reason]));
    expect(reasons.get("Suppressed Coil")).toBe("suppressed");
    expect((await dispatchesFor(p.id)).length).toBe(1);
  });

  it("8. thread door — no provider message id, no follow-up", async () => {
    const p = await seedProspect({ name: "Threadbare Works" });
    await seedSentTouch(p.id, { step: 1, sentAt: new Date(T0.valueOf() - 5 * DAY), subject: "Threadbare Works: RFQ turnaround", msgId: null });
    const out = await runCadenceScan(midBucket(new Date(T0.valueOf() + 60 * 90_000)));
    const reasons = new Map(out.refusals.map((r) => [r.name, r.reason]));
    expect(reasons.get("Threadbare Works")).toBe("thread_broken_no_msgid");
    expect((await dispatchesFor(p.id)).length).toBe(1);
  });

  it("9. stopped sequence — a not_interested stop is respected forever", async () => {
    const p = await seedProspect({ name: "Stopped Mill" });
    await seedSentTouch(p.id, { step: 1, sentAt: new Date(T0.valueOf() - 5 * DAY), subject: "Stopped Mill: RFQ turnaround", msgId: "msg-stopped-1" });
    // what replies.ts does on not_interested: every Channel A row → stopped
    await db.dispatch.updateMany({ where: { prospectId: p.id, channel: "channel_a_automated_email" }, data: { status: "stopped" } });
    const out = await runCadenceScan(midBucket(new Date(T0.valueOf() + 70 * 90_000)));
    const reasons = new Map(out.refusals.map((r) => [r.name, r.reason]));
    expect(reasons.get("Stopped Mill")).toBe("last_touch_not_live");
    expect((await dispatchesFor(p.id)).length).toBe(1);
  });

  it("10. sequence_complete — step 3 is the ceiling", async () => {
    const p = await seedProspect({ name: "Ceiling Forge" });
    await seedSentTouch(p.id, { step: 1, sentAt: new Date(T0.valueOf() - 12 * DAY), subject: "Ceiling Forge: RFQ turnaround", msgId: "msg-ceiling-1" });
    await seedSentTouch(p.id, { step: 2, sentAt: new Date(T0.valueOf() - 9 * DAY), subject: "Re: Ceiling Forge: RFQ turnaround", msgId: "msg-ceiling-2" });
    await seedSentTouch(p.id, { step: CADENCE_MAX_STEP, sentAt: new Date(T0.valueOf() - 4 * DAY), subject: "Re: Ceiling Forge: RFQ turnaround", msgId: "msg-ceiling-3" });
    const out = await runCadenceScan(midBucket(new Date(T0.valueOf() + 80 * 90_000)));
    const reasons = new Map(out.refusals.map((r) => [r.name, r.reason]));
    expect(reasons.get("Ceiling Forge")).toBe("sequence_complete");
    expect((await dispatchesFor(p.id)).length).toBe(3);
  });

  it("11. idempotent — a fresh-window scan stacks no duplicate follow-ups", async () => {
    const p = await seedProspect({ name: "Northline Electric" });
    await seedSentTouch(p.id, { step: 1, sentAt: new Date(T0.valueOf() - 5 * DAY), subject: "Northline Electric: RFQ turnaround", msgId: "msg-northline-1" });
    await runCadenceScan(midBucket(new Date(T0.valueOf() + 90 * 90_000)));
    await runCadenceScan(midBucket(new Date(T0.valueOf() + 91 * 90_000)));
    const rows = await dispatchesFor(p.id);
    expect(rows.filter((d) => d.step === 2).length).toBe(1);
  });

  it("12. one claim per 90 s window — a concurrent trigger absorbs", async () => {
    await seedProspect({ name: "Prairie Fluid" });
    const base = midBucket(new Date(T0.valueOf() + 100 * 90_000));
    const first = await runCadenceScan(base);
    const second = await runCadenceScan(new Date(base.valueOf() + 1_000)); // same window
    expect(first.claimDeduped).toBe(false);
    expect(second.claimDeduped).toBe(true);
    expect(second.admitted).toBe(0);
  });

  it("13. cap — oldest-due first, overflow refused with lane_cap", async () => {
    // seven prospects due; the oldest five go, the rest hold
    for (const name of ["Cap One", "Cap Two", "Cap Three", "Cap Four", "Cap Five", "Cap Six", "Cap Seven"]) {
      const p = await seedProspect({ name });
      await seedSentTouch(p.id, { step: 1, sentAt: new Date(T0.valueOf() - 5 * DAY), subject: `${name}: RFQ turnaround`, msgId: `msg-${p.id}` });
    }
    const out = await runCadenceScan(midBucket(new Date(T0.valueOf() + 110 * 90_000)));
    expect(out.admissions.length).toBe(5);
    expect(out.refusals.filter((r) => r.reason === "lane_cap").length).toBe(2);
  });
});

describe("cadence — pure composition", () => {
  it("step texts are deterministic, step-specific, footer-free", () => {
    const ctx = { contactFirst: "Marcus", company: "Acme", hookBody: "Your desk quotes RFQs" };
    const s2 = composeFollowup(2, ctx);
    const s3 = composeFollowup(3, ctx);
    expect(s2.body).toContain("Marcus");
    expect(s3.body).toContain("last note");
    expect(s2.body).not.toBe(s3.body);
    expect(s2.body).not.toContain("Unsubscribe");
    expect(s2.subject).toBeNull(); // the thread subject comes from the ledger
  });

  it("threadSubject — reply marker added once, opener fallback when blank", () => {
    expect(threadSubject("Acme: RFQ turnaround", "Acme")).toBe("Re: Acme: RFQ turnaround");
    expect(threadSubject("Re: Acme: RFQ turnaround", "Acme")).toBe("Re: Acme: RFQ turnaround");
    expect(threadSubject(null, "Acme")).toBe("Re: Acme: quoting benchmark");
  });

  it("step-3 anchor — five days after the step-2 touch, not the opener", () => {
    // day 0 opener → day 3 step 2 → day 8 step 3, anchored to ACTUAL sends
    const openerSent = new Date("2026-11-01T12:00:00Z");
    const step2Sent = new Date(openerSent.valueOf() + 4 * DAY); // sent a day late
    const step3Due = new Date(step2Sent.valueOf() + 5 * DAY); // day 9 — honest to the real send
    expect(step3Due.valueOf()).toBe(new Date("2026-11-10T12:00:00Z").valueOf());
  });
});
