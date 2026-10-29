/**
 * Portal engagement seed — idempotent fixtures for the Margin Defense desk.
 *
 * Three engagements spanning the desk's honesty spectrum:
 *   1. fresh webhook payment from a stranger        → status paid, unmatched
 *   2. webhook payment auto-matched onto the book   → status intake, volume recorded
 *   3. a fully worked audit that cleared the floor  → status delivered, guarantee CLEARED
 *
 * Re-runs converge: upserts keyed on the payment ref, events deduped by
 * (engagement, kind, detail). Never duplicates, never fabricates beyond the
 * fixture provenance declared on each row.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

interface EventSpec {
  kind: string;
  actor: string;
  detail: string;
  at: Date;
}

interface EngagementSpec {
  ref: string;
  clientName: string;
  clientDomain: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  tier: "diagnostic_audit" | "enterprise_sow";
  amountUsd: number;
  source: "portal_webhook" | "manual";
  status: string;
  intakeRfqPerMonth: number | null;
  intakeLineItems: number | null;
  guaranteeCleared: boolean | null;
  confirmedLeakageUsd: number | null;
  verdictNote: string | null;
  paidAt: Date;
  deliveredAt: Date | null;
  /** Client-domain to auto-match at seed time (same rule as the webhook). */
  matchDomain?: string;
  events: EventSpec[];
}

const SPECS: EngagementSpec[] = [
  {
    ref: "pay_landing_cedar_ridge_4471",
    clientName: "Cedar Ridge Fluid Power",
    clientDomain: "cedarridgefp.com",
    contactName: "Dana Whitfield",
    contactEmail: "dwhitfield@cedarridgefp.com",
    contactPhone: "+1 503 555 0184",
    tier: "diagnostic_audit",
    amountUsd: 3_500,
    source: "portal_webhook",
    status: "paid",
    intakeRfqPerMonth: null,
    intakeLineItems: null,
    guaranteeCleared: null,
    confirmedLeakageUsd: null,
    verdictNote: null,
    paidAt: daysAgo(0.2),
    deliveredAt: null,
    events: [
      { kind: "ingested", actor: "portal_webhook", detail: "diagnostic_audit · $3,500 · ref pay_landing_cedar_ridge_4471", at: daysAgo(0.2) },
    ],
  },
  {
    ref: "pay_landing_gulfcoast_9203",
    clientName: "Gulf Coast Valve & Fitting",
    clientDomain: "gulfcoastvalve.com",
    contactName: "Marcus Thibodeaux",
    contactEmail: "mthibodeaux@gulfcoastvalve.com",
    contactPhone: "+1 713 555 0117",
    tier: "diagnostic_audit",
    amountUsd: 3_500,
    source: "portal_webhook",
    status: "intake",
    intakeRfqPerMonth: 140,
    intakeLineItems: 26,
    guaranteeCleared: null,
    confirmedLeakageUsd: null,
    verdictNote: null,
    paidAt: daysAgo(4),
    deliveredAt: null,
    matchDomain: "gulfcoastvalve.com",
    events: [
      { kind: "ingested", actor: "portal_webhook", detail: "diagnostic_audit · $3,500 · ref pay_landing_gulfcoast_9203", at: daysAgo(4) },
      { kind: "prospect_linked", actor: "portal_webhook", detail: "auto-matched domain → Gulf Coast Valve & Fitting", at: daysAgo(4) },
      { kind: "stage_changed", actor: "operator", detail: "Paid → intake", at: daysAgo(3.6) },
      { kind: "note", actor: "operator", detail: "intake confirmed · 140 RFQ/mo · 26 lines/RFQ · contact Marcus Thibodeaux", at: daysAgo(3.5) },
    ],
  },
  {
    ref: "pay_landing_northline_7710",
    clientName: "Northline Electric Supply",
    clientDomain: "northlineelectric.com",
    contactName: "Evelyn Marsh",
    contactEmail: "emarsh@northlineelectric.com",
    contactPhone: "+1 312 555 0142",
    tier: "diagnostic_audit",
    amountUsd: 3_500,
    source: "portal_webhook",
    status: "delivered",
    intakeRfqPerMonth: 210,
    intakeLineItems: 18,
    guaranteeCleared: true,
    confirmedLeakageUsd: 28_400,
    verdictNote: "24 months of quotes traced; SPA-unapplied lines on 3 branch accounts carried the bulk of the confirmed recovery.",
    paidAt: daysAgo(21),
    deliveredAt: daysAgo(6),
    matchDomain: "northlineelectric.com",
    events: [
      { kind: "ingested", actor: "portal_webhook", detail: "diagnostic_audit · $3,500 · ref pay_landing_northline_7710", at: daysAgo(21) },
      { kind: "prospect_linked", actor: "portal_webhook", detail: "auto-matched domain → Northline Electric Supply", at: daysAgo(21) },
      { kind: "stage_changed", actor: "operator", detail: "Paid → intake", at: daysAgo(20) },
      { kind: "note", actor: "operator", detail: "intake confirmed · 210 RFQ/mo · 18 lines/RFQ · contact Evelyn Marsh", at: daysAgo(19) },
      { kind: "stage_changed", actor: "operator", detail: "Intake → forensics", at: daysAgo(17) },
      { kind: "stage_changed", actor: "operator", detail: "Forensics → verdict", at: daysAgo(9) },
      {
        kind: "verdict_recorded",
        actor: "operator",
        detail: "confirmed $28,400 recoverable · guarantee CLEARED · 24 months of quotes traced; SPA-unapplied lines on 3 branch accounts carried the bulk of the confirmed recovery.",
        at: daysAgo(8),
      },
      { kind: "stage_changed", actor: "operator", detail: "Verdict → delivered", at: daysAgo(6) },
      { kind: "delivered", actor: "operator", detail: "Verdict → delivered", at: daysAgo(6) },
    ],
  },
];

async function main() {
  console.log("seeding portal engagements…");
  for (const spec of SPECS) {
    // Auto-match by domain — same rule the webhook applies.
    let prospectId: string | null = null;
    if (spec.matchDomain) {
      const prospect = await db.prospect.findFirst({
        where: { domain: { equals: spec.matchDomain } },
        select: { id: true, name: true },
      });
      if (prospect) {
        prospectId = prospect.id;
        console.log(`  match: ${spec.clientName} → ${prospect.name}`);
      } else {
        console.log(`  match: ${spec.clientName} → NO MATCH (${spec.matchDomain})`);
      }
    }

    const events = spec.events.map((e) => ({ kind: e.kind, actor: e.actor, detail: e.detail, createdAt: e.at }));

    await db.engagement.upsert({
      where: { ref: spec.ref },
      create: {
        ref: spec.ref,
        clientName: spec.clientName,
        clientDomain: spec.clientDomain,
        contactName: spec.contactName,
        contactEmail: spec.contactEmail,
        contactPhone: spec.contactPhone,
        tier: spec.tier,
        amountUsd: spec.amountUsd,
        source: spec.source,
        status: spec.status,
        intakeRfqPerMonth: spec.intakeRfqPerMonth,
        intakeLineItems: spec.intakeLineItems,
        guaranteeCleared: spec.guaranteeCleared,
        confirmedLeakageUsd: spec.confirmedLeakageUsd,
        verdictNote: spec.verdictNote,
        prospectId,
        paidAt: spec.paidAt,
        deliveredAt: spec.deliveredAt,
        events: { create: events },
      },
      update: {
        // Converge the worked fields; operator-moved stages are respected when
        // the row has progressed beyond the fixture state (never regress).
        status: spec.status,
        intakeRfqPerMonth: spec.intakeRfqPerMonth,
        intakeLineItems: spec.intakeLineItems,
        guaranteeCleared: spec.guaranteeCleared,
        confirmedLeakageUsd: spec.confirmedLeakageUsd,
        verdictNote: spec.verdictNote,
        prospectId,
        deliveredAt: spec.deliveredAt,
      },
    });
    console.log(`  upserted ${spec.ref} (${spec.status})`);
  }
  const total = await db.engagement.count();
  console.log(`ledger: ${total} engagements · fixtures converged`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
