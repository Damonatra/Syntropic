/**
 * Dummy prospect cast — seeds the dev ledger (db/custom.db) with a designed
 * set of prospects so every state the sequence engine has is observable in
 * Ops. Every dummy is unmistakably fake: domainKey prefixed `dummy-`, every
 * address an RFC-reserved `*.example.com` — nothing here can ever receive
 * real mail, and nothing leaves the enclave anyway (no provider key = the
 * mailer stages sends honestly).
 *
 *   bun run scripts/seed_dummy_prospects.ts           # seed (re-runnable: clears dummies first)
 *   bun run scripts/seed_dummy_prospects.ts --undo    # remove every dummy row (cascades + replies + suppression)
 *   VERTEBRA_FASTLANE=on bun run scripts/seed_dummy_prospects.ts --tick
 *                                                     # run one sequence tick in-process against the cast
 *                                                     # (fastlane + cadence scans + send loop, staged sends)
 *
 * The cast (what the engine should do on the next armed tick):
 *   fresh, high QLV  → fastlane queues the opener (cap 5/scan, 0–90s jitter)
 *   mid QLV          → refused below_channel_a_bar (named in the pulse)
 *   no email         → invisible to the pool entirely
 *   suppressed       → refused suppressed
 *   vetoed           → refused vetoed_by_operator (the always-win card)
 *   opener 4d old    → cadence queues step 2, subject "Re: …", same thread
 *   step2 6d old     → cadence queues step 3 (day 8)
 *   step2 1d old     → not_due_yet (waits)
 *   OOO replied      → step 2 queued, anchored to the stated return date
 *   interested reply → cadence refuses; a fresh reply POST pages the humans
 *   not_interested   → sequence stopped forever (last_touch_not_live)
 *   all three sent   → sequence_complete (step 3 is the ceiling)
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const DAY = 86_400_000;
const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * DAY);
const daysAhead = (n: number) => new Date(now + n * DAY);

interface CastSpec {
  slug: string;
  name: string;
  qlv: number;
  band: string;
  city: string;
  country: string;
  caslScope: boolean;
  revenue: number;
  erp: string;
  portal: string;
  contact: { first: string; last: string; role: string };
  hook: string;
  bestEmail?: string | null;
}

const CAST: CastSpec[] = [
  {
    slug: "keystone", name: "Keystone Fabrication Group", qlv: 88, band: "prime",
    city: "Cleveland", country: "US", caslScope: false, revenue: 64_000_000,
    erp: "Epicor Kinetic", portal: "manual_mailto",
    contact: { first: "Dana", last: "Whitfield", role: "VP Operations" },
    hook: "Your desk quotes RFQs by email in about 26 hours on average — two fabrication shops your size cut that to 4 with a structured intake.",
  },
  {
    slug: "borroughs", name: "Borroughs Gasket & Seal", qlv: 91, band: "prime",
    city: "Houston", country: "US", caslScope: false, revenue: 81_000_000,
    erp: "JobBOSS2", portal: "static_pdf_form",
    contact: { first: "Marcus", last: "Idowu", role: "Owner" },
    hook: "Six of your top-20 customers submit quotes through a PDF form nobody versions — the pricing on file is 9 months stale.",
  },
  {
    slug: "tallgrass", name: "Tallgrass Pump & Valve", qlv: 84, band: "prime",
    city: "Wichita", country: "US", caslScope: false, revenue: 47_000_000,
    erp: "Made2Manage", portal: "legacy_portal",
    contact: { first: "Ellen", last: "Voss", role: "Plant Manager" },
    hook: "Your legacy quote portal drops attachments on submissions over 8 MB — your own sales desk mails those RFQs by hand.",
  },
  {
    slug: "meridian", name: "Meridian Scroll Compressors", qlv: 55, band: "watch",
    city: "Dayton", country: "US", caslScope: false, revenue: 22_000_000,
    erp: "QuickBooks", portal: "manual_mailto",
    contact: { first: "Owen", last: "Brant", role: "Sales Lead" },
    hook: "Quote requests arrive in a shared inbox nobody triages after 3pm.",
  },
  {
    slug: "ghostworks", name: "Ghostworks Tooling", qlv: 90, band: "prime",
    city: "Rockford", country: "US", caslScope: false, revenue: 58_000_000,
    erp: "SAP B1", portal: "undetermined",
    contact: { first: "Priya", last: "Nair", role: "COO" },
    hook: "No public quote channel at all — the desk is one person's inbox.",
    bestEmail: null,
  },
  {
    slug: "ossified", name: "Ossified Pipe Works", qlv: 87, band: "prime",
    city: "Birmingham", country: "US", caslScope: false, revenue: 39_000_000,
    erp: "Epicor Kinetic", portal: "manual_mailto",
    contact: { first: "Carl", last: "Munoz", role: "Ops Director" },
    hook: "Your quote desk re-types every RFQ header block by hand before pricing starts.",
  },
  {
    slug: "vandalia", name: "Vandalia Stamping", qlv: 89, band: "prime",
    city: "Vandalia", country: "US", caslScope: false, revenue: 52_000_000,
    erp: "NetSuite", portal: "modern_quote_api",
    contact: { first: "June", last: "Okafor", role: "GM" },
    hook: "Your quote API returns averages, not quotes — the desk overrides 40% of them.",
  },
  {
    slug: "coldwater", name: "Coldwater Extrusion", qlv: 86, band: "prime",
    city: "Grand Rapids", country: "US", caslScope: false, revenue: 44_000_000,
    erp: "JobBOSS2", portal: "manual_mailto",
    contact: { first: "Sam", last: "Delgado", role: "VP Manufacturing" },
    hook: "Manual quote intake costs your desk roughly 11 hours a week of re-keying.",
  },
  {
    slug: "redhill", name: "Redhill Bearing Works", qlv: 82, band: "prime",
    city: "Cincinnati", country: "US", caslScope: false, revenue: 36_000_000,
    erp: "Made2Manage", portal: "legacy_portal",
    contact: { first: "Ana", last: "Petrov", role: "Operations Manager" },
    hook: "Your legacy portal quotes from last quarter's price file — margin leaks on every steel move.",
  },
  {
    slug: "lakeshore", name: "Lakeshore Coupling Co", qlv: 80, band: "prime",
    city: "Milwaukee", country: "US", caslScope: false, revenue: 31_000_000,
    erp: "JobBOSS2", portal: "manual_mailto",
    contact: { first: "Theo", last: "Lang", role: "Sales Director" },
    hook: "RFQ attachments bypass your ERP entirely — quotes go out with stale freight numbers.",
  },
  {
    slug: "halyard", name: "Halyard Industrial Supply", qlv: 83, band: "prime",
    city: "Mississauga", country: "CA", caslScope: true, revenue: 68_000_000,
    erp: "SAP B1", portal: "static_pdf_form",
    contact: { first: "Renee", last: "Cormier", role: "Director of Ops" },
    hook: "Your PDF quote form has no validation — 1 in 6 RFQs comes back for missing fields.",
  },
  {
    slug: "granitepeak", name: "Granite Peak Machining", qlv: 85, band: "prime",
    city: "Manchester", country: "US", caslScope: false, revenue: 29_000_000,
    erp: "Epicor Kinetic", portal: "manual_mailto",
    contact: { first: "Walt", last: "Ferris", role: "Owner" },
    hook: "Your desk prices from memory on repeat RFQs — no quote history survives the person.",
  },
  {
    slug: "silobridge", name: "Silo Bridge Conveyance", qlv: 81, band: "prime",
    city: "Omaha", country: "US", caslScope: false, revenue: 41_000_000,
    erp: "NetSuite", portal: "legacy_portal",
    contact: { first: "Iris", last: "Mbeki", role: "COO" },
    hook: "Quote approvals wait on a plant walk — the number ages while it walks.",
  },
  {
    slug: "quietword", name: "Quietword Manufacturing", qlv: 79, band: "prime",
    city: "Hamilton", country: "CA", caslScope: true, revenue: 27_000_000,
    erp: "Made2Manage", portal: "manual_mailto",
    contact: { first: "Gord", last: "Stein", role: "Plant Manager" },
    hook: "Your quote desk answers RFQs in arrival order, not margin order.",
  },
  {
    slug: "paragon", name: "Paragon Forge & Fitting", qlv: 93, band: "prime",
    city: "Erie", country: "US", caslScope: false, revenue: 73_000_000,
    erp: "JobBOSS2", portal: "modern_quote_api",
    contact: { first: "Nadia", last: "Reyes", role: "Executive Lead" },
    hook: "Your quote API queues overnight — competitors quote inside the same business day.",
  },
];

/** The sent-touch history each slug carries (step, days-ago, subject suffix). */
const HISTORY: Record<string, Array<{ step: number; ago: number }>> = {
  coldwater: [{ step: 1, ago: 4 }], // step 2 due (day 3 passed)
  redhill: [
    { step: 1, ago: 12 },
    { step: 2, ago: 6 },
  ], // step 3 due (day 8 passed)
  lakeshore: [
    { step: 1, ago: 5 },
    { step: 2, ago: 1 },
  ], // waiting — day 5 of the step-3 window
  halyard: [{ step: 1, ago: 5 }], // + OOO reply → step 2 anchored to return date
  granitepeak: [
    { step: 1, ago: 12 },
    { step: 2, ago: 9 },
    { step: 3, ago: 4 },
  ], // sequence complete
  silobridge: [{ step: 1, ago: 5 }], // + interested reply → cadence must refuse
  quietword: [{ step: 1, ago: 5 }], // + not_interested reply → everything stopped
};

const REPLIES: Record<string, { intent: string; ago: number; subject: string; body: string; extractedJson?: string }> = {
  halyard: {
    intent: "out_of_office",
    ago: 2,
    subject: "Out of office",
    body: "I am away from the office with limited email access. For anything urgent please contact the desk on my return.",
    extractedJson: JSON.stringify({ return_date: daysAhead(6).toISOString().slice(0, 10) }),
  },
  silobridge: {
    intent: "interested",
    ago: 2,
    subject: "Re: Silo Bridge Conveyance: RFQ turnaround",
    body: "This sounds interesting — what does onboarding actually look like? We run NetSuite and the desk is drowning.",
  },
  quietword: {
    intent: "not_interested",
    ago: 3,
    subject: "Re: Quietword Manufacturing: RFQ turnaround",
    body: "Not interested, please remove us from your list.",
  },
};

function openerSubject(name: string): string {
  return `${name}: RFQ turnaround`;
}

async function undo(): Promise<void> {
  const dummies = await db.prospect.findMany({ where: { domainKey: { startsWith: "dummy-" } }, select: { id: true, name: true } });
  const ids = dummies.map((d) => d.id);
  if (ids.length > 0) {
    await db.inboundReply.deleteMany({ where: { prospectId: { in: ids } } }); // SetNull would orphan them — take the evidence with the row
    await db.suppressionRecord.deleteMany({ where: { prospectId: { in: ids } } });
    await db.prospect.deleteMany({ where: { id: { in: ids } } }); // cascades dispatches, scores, contacts, operatorActions
  }
  console.log(`undo — removed ${ids.length} dummy prospect(s)${ids.length > 0 ? `: ${dummies.map((d) => d.name).join(", ")}` : ""}`);
}

async function seed(): Promise<void> {
  await undo();
  let created = 0;
  for (const spec of CAST) {
    const p = await db.prospect.create({
      data: {
        source: "console",
        name: spec.name,
        domainKey: `dummy-${spec.slug}`,
        domain: `${spec.slug}.example.com`,
        website: `https://${spec.slug}.example.com`,
        vertical: "industrial manufacturing",
        region: spec.country === "CA" ? "Canada" : "US Midwest",
        city: spec.city,
        country: spec.country,
        employeeCount: 40 + (spec.qlv % 9) * 15,
        revenueEstimateUsd: spec.revenue,
        revenueConfidence: "medium",
        detectedErp: spec.erp,
        quotePortalType: spec.portal,
        ingestion: "ingested",
        caslScope: spec.caslScope,
        caslReason: spec.caslScope ? "Canadian domain — CRTL-implied consent window" : null,
        bestEmail: spec.bestEmail === null ? null : `ops@${spec.slug}.example.com`,
        emailPattern: spec.bestEmail === null ? null : "ops@{domain}",
        contacts: {
          create: {
            firstName: spec.contact.first,
            lastName: spec.contact.last,
            role: spec.contact.role,
            titleRaw: spec.contact.role,
            phone: `+1-555-01${(CAST.indexOf(spec) % 80 + 10).toString()}`,
          },
        },
        scores: {
          create: {
            qlvScore: spec.qlv,
            band: spec.band,
            factorsJson: JSON.stringify({ portal_drift: 0.3, rfq_latency: 0.5, spa_leakage: 0.2 }),
            hooksJson: JSON.stringify([{ flavor: "rfq_latency", body: spec.hook }]),
            rationale: "dummy cast — deterministic test fixture, not a real audit",
            model: "dummy-seed-v1",
            fingerprint: `dummy-${spec.slug}-v1`,
          },
        },
      },
      select: { id: true, name: true },
    });
    created += 1;

    // Sent-touch history — raw-pinned updatedAt so cadence windows are real.
    const steps = HISTORY[spec.slug] ?? [];
    for (const h of steps) {
      const sentAt = daysAgo(h.ago);
      const subject = h.step === 1 ? openerSubject(spec.name) : `Re: ${openerSubject(spec.name)}`;
      const row = await db.dispatch.create({
        data: {
          prospectId: p.id,
          channel: "channel_a_automated_email",
          status: "sent",
          step: h.step,
          subject,
          provider: "resend",
          providerMsgId: `dummy-msg-${spec.slug}-s${h.step}`,
          caslScope: spec.caslScope,
          footerApplied: "casl",
          scheduledAt: sentAt,
        },
        select: { id: true },
      });
      await db.$executeRawUnsafe(`UPDATE Dispatch SET updatedAt = ? WHERE id = ?`, sentAt, row.id);
    }

    // Reply history.
    const reply = REPLIES[spec.slug];
    if (reply) {
      await db.inboundReply.create({
        data: {
          prospectId: p.id,
          fromEmail: `ops@${spec.slug}.example.com`,
          subject: reply.subject,
          body: reply.body,
          intent: reply.intent,
          intentConfidence: 0.92,
          rationale: `${reply.intent} — dummy cast fixture (keyword-deterministic)`,
          extractedJson: reply.extractedJson ?? null,
          processedAt: daysAgo(reply.ago),
          receivedAt: daysAgo(reply.ago),
        },
      });
      if (reply.intent === "not_interested") {
        // what the reply brain does: every Channel A row stops
        await db.dispatch.updateMany({ where: { prospectId: p.id, channel: "channel_a_automated_email" }, data: { status: "stopped" } });
      }
    }

    // The gates.
    if (spec.slug === "ossified") {
      await db.suppressionRecord.create({
        data: { email: `ops@${spec.slug}.example.com`, prospectId: p.id, reason: "unsubscribe", source: "unsubscribe_link" },
      });
    }
    if (spec.slug === "vandalia") {
      await db.operatorAction.create({ data: { prospectId: p.id, action: "vetoed", actor: "damon", note: "dummy cast — do not touch this account" } });
    }
  }

  console.log(`\nseeded ${created} dummy prospects (domainKey prefix "dummy-", addresses all *.example.com):\n`);
  const rows: Array<[string, string]> = [
    ["Keystone / Borroughs / Tallgrass / Paragon", "fresh, QLV 84–93 → fastlane queues the opener (cap 5)"],
    ["Meridian Scroll Compressors", "QLV 55 → refused below_channel_a_bar (named in the pulse)"],
    ["Ghostworks Tooling", "no verified email → invisible to the pool"],
    ["Ossified Pipe Works", "suppressed (unsubscribe) → refused suppressed"],
    ["Vandalia Stamping", "vetoed by damon → refused vetoed_by_operator FIRST"],
    ["Coldwater Extrusion", "opener sent 4d ago → cadence queues step 2, subject Re:"],
    ["Redhill Bearing Works", "step 2 sent 6d ago → cadence queues step 3 (day 8)"],
    ["Lakeshore Coupling Co", "step 2 sent 1d ago → not_due_yet, waits"],
    ["Halyard Industrial Supply", "OOO reply → step 2 queued, anchored to the return date"],
    ["Granite Peak Machining", "all 3 steps sent → sequence_complete, ceiling"],
    ["Silo Bridge Conveyance", "interested reply 2d ago → reply_landed_conversation_live"],
    ["Quietword Manufacturing", "not_interested → every dispatch stopped, respected forever"],
  ];
  for (const [who, what] of rows) console.log(`  ${who.padEnd(46)} ${what}`);
  console.log(`\nnext: arm the lanes (VERTEBRA_FASTLANE=on, restart dev server), then RUN TICK in Ops —\n`);
  console.log(`  or: VERTEBRA_FASTLANE=on bun run scripts/seed_dummy_prospects.ts --tick\n`);
}

/** One in-process sequence tick against the cast — proves the whole loop. */
async function tick(): Promise<void> {
  process.env.VERTEBRA_FASTLANE = process.env.VERTEBRA_FASTLANE || "on";
  const { runSequenceTick } = await import("@/lib/vertebra/tick");
  const out = await runSequenceTick();
  const lane = (label: string, scan: { armed: boolean; admitted: number; scanned: number; admissions: Array<{ name: string; step?: number }>; refusals: Array<{ name: string; reason: string }> } | null) => {
    if (!scan) return `${label}: scan crashed`;
    if (!scan.armed) return `${label}: DISARMED`;
    const got = scan.admissions.map((a) => `${a.name}${a.step ? ` step ${a.step}` : ""}`).join(", ") || "—";
    const held = scan.refusals.map((r) => `${r.name}: ${r.reason}`).join(" · ") || "—";
    return `${label}: admitted ${scan.admitted}/${scan.scanned}\n    got:    ${got}\n    held:   ${held}`;
  };
  console.log(`[tick] provider=${out.provider} · due=${out.due} sent=${out.sent} deferred=${out.deferred} failed=${out.failed} stopped=${out.stopped}`);
  console.log(`  ${lane("fastlane", out.fastlane)}`);
  console.log(`  ${lane("cadence", out.cadence)}`);
  if (out.details.length > 0) {
    console.log(`  send loop:`);
    for (const d of out.details) console.log(`    ${d.outcome.padEnd(14)} ${d.prospect}${d.note ? ` — ${d.note}` : ""}`);
  }
  console.log(`\n(staged sends are honest: no RESEND_API_KEY in the enclave, so queued rows wait with\n "staged: no provider configured" — nothing leaves the building. Paging lands as pulse\n rows in Ops: no Telegram/Slack channels configured.)`);
}

const mode = process.argv[2];
if (mode === "--undo") await undo();
else if (mode === "--tick") await tick();
else await seed();
await db.$disconnect();
