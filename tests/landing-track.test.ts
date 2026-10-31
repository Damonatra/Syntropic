/**
 * The tracked funnel — landing tokens, portal-event recording, and the
 * link-carrying composers.
 *
 *   1. token roundtrip + tamper rejection (the HMAC is the prospect's face)
 *   2. recordPortalEvent — event row + heat bump + hour-deduped alert at QLV ≥ 85
 *   3. low-QLV prospects visit silently (heat moves, no page)
 *   4. the composers carry the tracked link when given it, never invent one
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

vi.hoisted(() => {
  process.env.DATABASE_URL = `file:${process.cwd()}/db/landing-test.db`;
});

import { db } from "@/lib/db";
import { landingToken, landingUrlFor, publicBaseUrl, verifyLandingToken } from "@/lib/vertebra/track";
import { recordPortalEvent } from "@/lib/vertebra/portal-events";
import { composeFollowup } from "@/lib/vertebra/cadence";

const SCRATCH = join(process.cwd(), "db", "landing-test.db");

beforeAll(async () => {
  rmSync(SCRATCH, { force: true });
  rmSync(`${SCRATCH}-journal`, { force: true });
  execSync("npx prisma db push --skip-generate", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${SCRATCH}` },
    stdio: "pipe",
  });
  delete process.env.VERTEBRA_PUBLIC_BASE_URL; // default base for determinism
});

afterAll(async () => {
  await db.$disconnect();
});

let seq = 0;
async function seedScored(opts: { name: string; qlv: number }) {
  seq += 1;
  const slug = opts.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return db.prospect.create({
    data: {
      name: opts.name,
      domainKey: `dk-track-${slug}-${seq}`,
      bestEmail: `ops@${slug}.example.com`,
      lastIntentHeat: 10,
      contacts: { create: { firstName: "Dana", lastName: "Reyes", role: "VP Operations", titleRaw: "VP Operations" } },
      scores: {
        create: {
          qlvScore: opts.qlv,
          band: opts.qlv >= 85 ? "critical" : "high",
          factorsJson: JSON.stringify([{ key: "rfq_latency", weight: 0.28, points: 82, evidence: "fixture" }]),
          hooksJson: JSON.stringify([{ flavor: "rfq_latency", body: "quotes in 26 hours" }]),
          rationale: "track fixture",
          model: "test",
          fingerprint: `fp-track-${seq}-${Date.now()}`,
        },
      },
    },
    select: { id: true, name: true, lastIntentHeat: true },
  });
}

describe("landing tokens", () => {
  it("1. roundtrip — the token verifies back to the prospect id", () => {
    const id = " prospect-row-001 ".trim();
    const token = landingToken(id);
    expect(token).toContain(".");
    expect(verifyLandingToken(token)).toBe(id);
    expect(landingUrlFor(id)).toBe(`${publicBaseUrl()}/l/${token}`);
  });

  it("2. tamper and garbage refuse — no enumeration oracle", () => {
    const token = landingToken("prospect-row-001");
    expect(verifyLandingToken(`${token}x`)).toBeNull(); // appended sig
    expect(verifyLandingToken(token.replace("prospect", "prospector"))).toBeNull(); // swapped id
    expect(verifyLandingToken("no-signature-here")).toBeNull();
    expect(verifyLandingToken("")).toBeNull();
    expect(verifyLandingToken(null)).toBeNull();
    expect(verifyLandingToken(undefined)).toBeNull();
  });
});

describe("recordPortalEvent — the shared recorder", () => {
  it("3. visit on a critical-band prospect — event row, heat bump, alert fired", async () => {
    const p = await seedScored({ name: "Hotshop Fabrication", qlv: 91 });
    const out = await recordPortalEvent({ prospectId: p.id, eventType: "portal_visit", source: "landing" });
    expect(out.heat).toBe(16); // 10 + 6
    expect(out.alert).toBeTruthy();
    expect(out.alert!.title).toBe("HIGH-INTENT PROSPECT ON PORTAL");
    const events = await db.telemetryEvent.findMany({ where: { prospectId: p.id } });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("portal_visit");

    // the hour-bucket dedupe — a second visit bumps heat but re-pages nobody
    const again = await recordPortalEvent({ prospectId: p.id, eventType: "portal_visit", source: "landing" });
    expect(again.heat).toBe(22);
    expect(again.alert).toBeNull();
  });

  it("4. document_download weighs heaviest — heat +12", async () => {
    const p = await seedScored({ name: "Download Bench", qlv: 60 }); // below the alert bar
    const out = await recordPortalEvent({ prospectId: p.id, eventType: "document_download", source: "audit" });
    expect(out.heat).toBe(22); // 10 + 12
    expect(out.alert).toBeNull(); // QLV 60 never pages
  });

  it("5. low-QLV prospect — silent visit, no alert row", async () => {
    const p = await seedScored({ name: "Quiet Lathe Works", qlv: 71 });
    const out = await recordPortalEvent({ prospectId: p.id, eventType: "audit_view", source: "landing" });
    expect(out.heat).toBe(19); // 10 + 9
    expect(out.alert).toBeNull();
    expect(await db.intentAlert.count({ where: { prospectId: p.id } })).toBe(0);
  });
});

describe("composers — the tracked link rides the body", () => {
  it("6. follow-ups carry the one-page link when given it", () => {
    const ctx = { contactFirst: "Dana", company: "Hotshop", hookBody: "quotes in 26 hours", landingUrl: "https://syn.example/l/abc.123" };
    const s2 = composeFollowup(2, ctx);
    expect(s2.body).toContain("The one-page math: https://syn.example/l/abc.123");
    const s3 = composeFollowup(3, ctx);
    expect(s3.body).toContain("https://syn.example/l/abc.123");
  });

  it("7. no link in context — the body never invents one", () => {
    const s2 = composeFollowup(2, { contactFirst: "Dana", company: "Hotshop", hookBody: null });
    expect(s2.body).not.toContain("/l/");
  });
});
