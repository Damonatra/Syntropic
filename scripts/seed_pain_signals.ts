/**
 * Seed verbatim pain signals for the sandbox prospects — fixture data so the
 * 1:1 personalization layer is exercisable end-to-end. Every signal is tagged
 * `seed fixture` in sourceNote; the ledger stays honest about its own data.
 * Idempotent: skips a prospect that already carries signals.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const FIXTURES: Record<string, Array<{ kind: string; verbatim: string; context?: string; sourceNote: string; confidence: string }>> = {
  "Gulf Coast Valve & Fitting": [
    {
      kind: "review_complaint",
      verbatim: "took four days just to get a quote back on valve packages",
      context: "Google review left by a mechanical contractor",
      sourceNote: "seed fixture — public review of quoting experience",
      confidence: "high",
    },
    {
      kind: "site_copy",
      verbatim: "our inside sales team will respond within 5-7 business days",
      context: "their own quote-request page",
      sourceNote: "seed fixture — prospect website copy",
      confidence: "high",
    },
  ],
  "Maple Climate Systems": [
    {
      kind: "reply_language",
      verbatim: "we keep losing track of which supplier SPAs apply to our quotes",
      context: "reply to an earlier outreach",
      sourceNote: "seed fixture — inbound reply language",
      confidence: "high",
    },
    {
      kind: "job_posting",
      verbatim: "hiring a quoting coordinator to keep up with contractor RFQ volume",
      context: "Careers page posting",
      sourceNote: "seed fixture — job posting",
      confidence: "medium",
    },
  ],
  "Bayou Pipe & Supply Co": [
    {
      kind: "site_copy",
      verbatim: "email your RFQ to our quoting desk and allow up to one week for pricing",
      context: "contact page instructions to customers",
      sourceNote: "seed fixture — prospect website copy",
      confidence: "high",
    },
  ],
  "Magnolia Industrial Flange": [
    {
      kind: "reply_language",
      verbatim: "half our quotes go out with stale SPA pricing",
      context: "reply thread on file",
      sourceNote: "seed fixture — inbound reply language",
      confidence: "high",
    },
  ],
};

async function main() {
  const prospects = await db.prospect.findMany({ select: { id: true, name: true } });
  let created = 0;
  for (const p of prospects) {
    const fixtures = FIXTURES[p.name];
    if (!fixtures) continue;
    const existing = await db.painSignal.count({ where: { prospectId: p.id } });
    if (existing > 0) {
      console.log(`skip ${p.name} — ${existing} signal(s) already on file`);
      continue;
    }
    for (const f of fixtures) {
      await db.painSignal.create({
        data: {
          prospectId: p.id,
          kind: f.kind,
          verbatim: f.verbatim,
          context: f.context ?? null,
          sourceNote: f.sourceNote,
          confidence: f.confidence,
        },
      });
      created++;
    }
    console.log(`seeded ${fixtures.length} signal(s) → ${p.name}`);
  }
  console.log(`total created: ${created}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
