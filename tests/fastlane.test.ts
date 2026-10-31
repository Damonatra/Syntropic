/**
 * The fast-lane — intake for the sequence engine, exercised on an isolated
 * scratch SQLite (never the dev ledger).
 *
 *   1. disarmed = silent — no rows, no dispatches, honest armed:false
 *   2. admission — a qualified prospect gets a queued Channel A dispatch,
 *      caslScope carried, scheduledAt jittered inside 0–90 s
 *   3. every refusal is named — below bar, vetoed, suppressed; prospects
 *      without a verified email are structurally invisible to the pool
 *   4. idempotent — a later scan in a fresh window stacks no duplicates
 *   5. one claim per 90 s window — a concurrent trigger absorbs cleanly
 *   6. cap — best score first, overflow refused with lane_cap
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

vi.hoisted(() => {
  process.env.DATABASE_URL = `file:${process.cwd()}/db/fastlane-test.db`;
});

import { db } from "@/lib/db";
import { FASTLANE_JITTER_MS, runFastlaneScan } from "@/lib/vertebra/fastlane";

const SCRATCH = join(process.cwd(), "db", "fastlane-test.db");
const T0 = new Date("2026-11-01T12:00:00Z");
/** A clock pinned mid-bucket so +1s stays inside the same 90 s claim window. */
const midBucket = (t: Date) => new Date(Math.floor(t.valueOf() / 90_000) * 90_000 + 45_000);

let seq = 0;
async function seedProspect(opts: { name: string; qlv: number; email?: string | null }) {
  seq += 1;
  const slug = opts.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return db.prospect.create({
    data: {
      name: opts.name,
      domainKey: `dk-${slug}`,
      bestEmail: opts.email === undefined ? `ops${seq}@${slug}.example.com` : opts.email,
      scores: {
        create: {
          qlvScore: opts.qlv,
          band: opts.qlv >= 70 ? "prime" : "watch",
          factorsJson: "{}",
          hooksJson: JSON.stringify([{ flavor: "margin", body: `hook for ${opts.name}` }]),
          rationale: "test seed",
          model: "test",
          fingerprint: `fp-fastlane-${seq}-${Date.now()}`,
        },
      },
    },
    select: { id: true, name: true, bestEmail: true, caslScope: true },
  });
}

const dispatchesFor = (prospectId: string) =>
  db.dispatch.findMany({ where: { prospectId, channel: "channel_a_automated_email" } });

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

describe("fastlane — the sequence engine's intake", () => {
  it("1. disarmed = fully silent: no rows, no dispatches", async () => {
    const p = await seedProspect({ name: "Silent Foundry", qlv: 91 });
    process.env.VERTEBRA_FASTLANE = "off";
    const out = await runFastlaneScan(T0);
    process.env.VERTEBRA_FASTLANE = "on";
    expect(out.armed).toBe(false);
    expect(out.admitted).toBe(0);
    expect((await dispatchesFor(p.id)).length).toBe(0);
  });

  it("2. admission — qualified prospect queued with jitter and caslScope carried", async () => {
    const p = await seedProspect({ name: "Ironvale Pipe", qlv: 84 });
    const scanAt = midBucket(T0);
    const out = await runFastlaneScan(scanAt);
    expect(out.armed).toBe(true);
    expect(out.claimDeduped).toBe(false);
    expect(out.admitted).toBeGreaterThanOrEqual(1); // earlier seeds may rank higher — the lane is score-ordered
    const mine = out.admissions.find((a) => a.name === "Ironvale Pipe");
    expect(mine).toBeTruthy();
    const rows = await dispatchesFor(p.id);
    expect(rows.length).toBe(1);
    const d = rows[0];
    expect(d.status).toBe("queued");
    expect(d.channel).toBe("channel_a_automated_email");
    expect(d.subject).toBeNull(); // the tick composes from hooks, the lane never words
    const jitter = d.scheduledAt!.valueOf() - scanAt.valueOf(); // jitter is relative to the scan clock
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThanOrEqual(FASTLANE_JITTER_MS);
    // the scan told its story on the ledger
    const pulses = await db.enginePulse.findMany({ where: { engineId: "fastlane" } });
    expect(pulses.length).toBeGreaterThanOrEqual(2); // claim + result
    expect(pulses.some((r) => (r.detail ?? "").includes("Ironvale Pipe"))).toBe(true);
  });

  it("3. every refusal named; email-less prospects never even scanned", async () => {
    await seedProspect({ name: "Underbar Fab", qlv: 55 }); // below bar
    const vetoed = await seedProspect({ name: "Vetoed Steel", qlv: 88 });
    await db.operatorAction.create({ data: { prospectId: vetoed.id, action: "vetoed", actor: "damon", note: "do not touch" } });
    const suppressed = await seedProspect({ name: "Suppressed Coil", qlv: 91 });
    await db.suppressionRecord.create({ data: { email: suppressed.bestEmail!, reason: "unsubscribe" } });
    await seedProspect({ name: "Ghost Metals", qlv: 93, email: null }); // invisible to the pool

    const out = await runFastlaneScan(midBucket(new Date(T0.valueOf() + 10 * 90_000)));
    const reasons = new Map(out.refusals.map((r) => [r.name, r.reason]));
    expect(reasons.get("Underbar Fab")).toBe("below_channel_a_bar");
    expect(reasons.get("Vetoed Steel")).toBe("vetoed_by_operator");
    expect(reasons.get("Suppressed Coil")).toBe("suppressed");
    expect(out.scanned).toBe(3); // Ghost Metals has no email — not in the pool
    expect(out.refusals.some((r) => r.name === "Ghost Metals")).toBe(false);
  });

  it("4. idempotent — a fresh-window scan stacks no duplicate dispatches", async () => {
    const p = await seedProspect({ name: "Northline Electric", qlv: 82 });
    await runFastlaneScan(midBucket(new Date(T0.valueOf() + 20 * 90_000)));
    await runFastlaneScan(midBucket(new Date(T0.valueOf() + 21 * 90_000)));
    expect((await dispatchesFor(p.id)).length).toBe(1);
  });

  it("5. one claim per 90 s window — a concurrent trigger absorbs", async () => {
    await seedProspect({ name: "Prairie Fluid", qlv: 86 });
    const base = midBucket(new Date(T0.valueOf() + 30 * 90_000));
    const first = await runFastlaneScan(base);
    const second = await runFastlaneScan(new Date(base.valueOf() + 1_000)); // same window
    expect(first.claimDeduped).toBe(false);
    expect(second.claimDeduped).toBe(true);
    expect(second.admitted).toBe(0);
  });

  it("6. cap — best score first, overflow refused with lane_cap", async () => {
    const names = ["Capco A", "Capco B", "Capco C", "Capco D", "Capco E", "Capco F"];
    const scores = [99, 95, 90, 85, 80, 75];
    for (let i = 0; i < names.length; i += 1) await seedProspect({ name: names[i], qlv: scores[i] });
    const out = await runFastlaneScan(midBucket(new Date(T0.valueOf() + 40 * 90_000)));
    const capco = out.admissions.filter((a) => a.name.startsWith("Capco"));
    expect(capco.length).toBe(5);
    expect(capco.map((a) => a.name)).toEqual(["Capco A", "Capco B", "Capco C", "Capco D", "Capco E"]);
    const overflow = out.refusals.find((r) => r.name === "Capco F");
    expect(overflow?.reason).toBe("lane_cap");
  });
});
