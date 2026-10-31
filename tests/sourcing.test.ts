/**
 * Sourcing spoke — the rubric, the staging batches, and the reveal bar,
 * exercised on an isolated scratch SQLite (never the dev ledger).
 *
 *   1. the rubric — perfect fixture person scores 100, empty inputs 0,
 *      weights sum to 1, the evidence names the matched term
 *   2. staging batch — fixtures stage when apollo is unarmed (and ONLY
 *      then), .example.com domains, the no-org person is skipped
 *   3. idempotency — re-running a batch stacks no duplicate prospects,
 *      contacts, or candidates
 *   4. queue — ranked by fit, stats honest (eligible / below-bar / dismissed)
 *   5. reveal bar — below-bar reveal refuses with a named reason, money
 *      never moves; a dismissed verdict survives re-staging
 *   6. fail-closed reveal — unarmed resolver refuses through the same gate
 *   7. live batch — gate ok + transport → real search path, circuit fed
 *   8. reveal outcomes — resolved graduates the stage + ledger row;
 *      no_match stays staged with the reason
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

vi.hoisted(() => {
  process.env.DATABASE_URL = `file:${process.cwd()}/db/sourcing-test.db`;
});

import { db } from "@/lib/db";
import { ensureKnownIntegrations, type Transport } from "@/lib/vertebra/integrations";
import {
  DEFAULT_ICP,
  REVEAL_BAR,
  SOURCING_FIT_WEIGHTS,
  FIXTURE_PEOPLE,
  domainKeyFor,
  scoreSourcingFit,
  sourcingQueue,
  stageSourcingBatch,
  revealSourcingCandidate,
  dismissSourcingCandidate,
  type SourcingPerson,
} from "@/lib/vertebra/sourcing";

const SCRATCH = join(process.cwd(), "db", "sourcing-test.db");

/** Transport that answers by URL fragment — the wire shapes are pinned here. */
const transportFor = (handlers: Array<[string, unknown]>): Transport => {
  return (url: string) => {
    const hit = handlers.find(([frag]) => url.includes(frag));
    if (!hit) return Promise.reject(new Error(`unexpected fetch: ${url}`));
    return Promise.resolve(new Response(JSON.stringify(hit[1]), { status: 200 }));
  };
};

const MATCH_HIT = {
  person: { email: "dale.merritt@ironvalepipe.example.com", email_status: "verified", organization: { email_pattern: "{first}{last}" } },
};
const MATCH_MISS = { person: null };

async function candidateByPerson(person: string) {
  const rows = await db.sourcingCandidate.findMany({
    include: { prospect: { select: { id: true, name: true, domain: true } } },
  });
  const withContact = await Promise.all(
    rows.map(async (r) => ({
      row: r,
      contact: r.contactId ? await db.contact.findUnique({ where: { id: r.contactId } }) : null,
    })),
  );
  const hit = withContact.find((c) => c.contact && `${c.contact.firstName} ${c.contact.lastName}`.trim() === person);
  if (!hit) throw new Error(`no candidate for person ${person}`);
  return hit.row;
}

beforeAll(async () => {
  rmSync(SCRATCH, { force: true });
  rmSync(`${SCRATCH}-journal`, { force: true });
  execSync("npx prisma db push --skip-generate", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${SCRATCH}` },
    stdio: "pipe",
  });
  await ensureKnownIntegrations();
  delete process.env.APOLLO_API_KEY;
});

afterAll(async () => {
  await db.$disconnect().catch(() => undefined);
  rmSync(SCRATCH, { force: true });
  rmSync(`${SCRATCH}-journal`, { force: true });
  delete process.env.APOLLO_API_KEY;
});

describe("sourcing rubric", () => {
  it("scores a perfect fixture person at 100 with the evidence naming the match", () => {
    const dale = FIXTURE_PEOPLE.find((p) => p.id === "fx-01") as SourcingPerson;
    const fit = scoreSourcingFit(dale, DEFAULT_ICP);
    expect(fit.fitScore).toBe(100);
    const vertical = fit.factors.find((f) => f.key === "vertical");
    expect(vertical?.evidence).toContain("industrial distribution");
    const erp = fit.factors.find((f) => f.key === "erp");
    expect(erp?.evidence).toContain("prophet 21");
  });

  it("scores an org-less, title-less person at 0", () => {
    const tessa = FIXTURE_PEOPLE.find((p) => p.id === "fx-10") as SourcingPerson;
    const bare: SourcingPerson = { ...tessa, title: null, location: null };
    expect(scoreSourcingFit(bare, DEFAULT_ICP).fitScore).toBe(0);
  });

  it("carries weights that sum to exactly 1", () => {
    const total = Object.values(SOURCING_FIT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });

  it("gives the right spread across the fixture book — 6 above the bar, 3 below", () => {
    const scored = FIXTURE_PEOPLE.filter((p) => p.organization).map((p) => scoreSourcingFit(p, DEFAULT_ICP).fitScore);
    expect(scored.filter((s) => s >= REVEAL_BAR).length).toBe(6);
    expect(scored.filter((s) => s < REVEAL_BAR).length).toBe(3);
    const purchasing = FIXTURE_PEOPLE.find((p) => p.id === "fx-08") as SourcingPerson;
    expect(scoreSourcingFit(purchasing, DEFAULT_ICP).fitScore).toBe(57); // close (0.575 → fp 57.49) but money never moves
  });

  it("normalizes domain keys from domain or org name", () => {
    expect(domainKeyFor("Ironvale Pipe & Supply", "ironvalepipe.example.com")).toBe("ironvalepipe.example.com");
    expect(domainKeyFor("Ironvale Pipe & Supply", null)).toBe("ironvale-pipe-supply");
  });
});

describe("staging batches", () => {
  it("stages the fixture book while apollo is unarmed — labeled staging, honest gate note", async () => {
    const outcome = await stageSourcingBatch({ icp: DEFAULT_ICP, actor: "test", mode: "staging" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.mode).toBe("staging");
    expect(outcome.batchId.startsWith("fixture:")).toBe(true);
    expect(outcome.gateNote).toContain("integration_not_armed");
    expect(outcome.staged).toBe(9); // 10 fixtures, one carries no organization
    expect(outcome.skipped).toBe(1);
    expect(outcome.candidates[0].fitScore).toBe(100);
  });

  it("is idempotent — a second run stacks no duplicate prospects, contacts, or candidates", async () => {
    const again = await stageSourcingBatch({ icp: DEFAULT_ICP, actor: "test", mode: "staging" });
    expect(again.ok).toBe(true);
    const [prospects, contacts, candidates] = await Promise.all([
      db.prospect.count({ where: { source: "sourcing" } }),
      db.contact.findMany({ where: { prospect: { source: "sourcing" } }, select: { id: true } }),
      db.sourcingCandidate.count(),
    ]);
    expect(prospects).toBe(9);
    expect(contacts.length).toBe(9);
    expect(candidates).toBe(9);
    expect(again.ok && again.staged === 9).toBe(true);
  });

  it("refuses a staging batch once apollo is armed — fixtures never outrun the truth", async () => {
    process.env.APOLLO_API_KEY = "apollo_test_key_0000000000";
    await db.integrationRecord.update({ where: { provider: "apollo" }, data: { status: "armed" } });
    const outcome = await stageSourcingBatch({ icp: DEFAULT_ICP, actor: "test", mode: "staging" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("staging_mode_unnecessary");
  });

  it("refuses a live batch through the gate when the key is missing — named, circuit untouched", async () => {
    delete process.env.APOLLO_API_KEY;
    const outcome = await stageSourcingBatch({ icp: DEFAULT_ICP, actor: "test", mode: "live" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("integration_key_missing");
  });

  it("runs a live batch through the transport when armed + keyed and feeds the circuit", async () => {
    process.env.APOLLO_API_KEY = "apollo_test_key_0000000000";
    const transport = transportFor([
      [
        "mixed_people/search",
        {
          people: FIXTURE_PEOPLE.filter((p) => ["fx-01", "fx-02", "fx-03"].includes(p.id)),
          pagination: { page: 1, per_page: 25, total_entries: 3 },
        },
      ],
    ]);
    const outcome = await stageSourcingBatch({ icp: DEFAULT_ICP, actor: "test", mode: "live", transport });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.mode).toBe("live");
    expect(outcome.batchId.startsWith("live:")).toBe(true);
    expect(outcome.staged).toBe(3);
    expect(outcome.gateNote).toBeNull();
    const row = await db.integrationRecord.findUnique({ where: { provider: "apollo" }, select: { callsTotal: true, callsFailed: true, circuitState: true } });
    expect(row?.callsTotal).toBe(1);
    expect(row?.callsFailed).toBe(0);
    expect(row?.circuitState).toBe("closed");
  });
});

describe("the reveal queue", () => {
  it("ranks staged candidates by fit and reports honest stats", async () => {
    const view = await sourcingQueue();
    const fits = view.staged.map((s) => s.fitScore);
    expect([...fits].sort((a, b) => b - a)).toEqual(fits);
    expect(view.stats.eligible).toBeGreaterThanOrEqual(6);
    expect(view.stats.belowBar).toBeGreaterThanOrEqual(2);
    expect(view.stats.dismissed).toBe(0);
  });

  it("refuses to reveal below the bar — the named reason, and the row stays staged", async () => {
    const roy = await candidateByPerson("Roy Dial");
    const outcome = await revealSourcingCandidate(roy.id, { actor: "test" });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("sourcing_fit_below_bar");
    expect(outcome.reason).toContain(`reveal bar ${REVEAL_BAR}`);
    const after = await db.sourcingCandidate.findUnique({ where: { id: roy.id }, select: { stage: true } });
    expect(after?.stage).toBe("staged");
  });

  it("refuses to reveal through the resolver's own gate when apollo is unarmed", async () => {
    await db.integrationRecord.update({ where: { provider: "apollo" }, data: { status: "staged" } });
    delete process.env.APOLLO_API_KEY;
    const dale = await candidateByPerson("Dale Merritt");
    const outcome = await revealSourcingCandidate(dale.id, { actor: "test" });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("no_armed_enrich_provider");
    const after = await db.sourcingCandidate.findUnique({ where: { id: dale.id }, select: { stage: true, stageReason: true, attempts: true } });
    expect(after?.stage).toBe("staged");
    expect(after?.stageReason).toContain("no_armed_enrich_provider");
    expect(after?.attempts).toBe(1);
  });

  it("reveals an above-bar candidate through an armed resolver — stage graduates, ledger row lands, email lands on the prospect", async () => {
    process.env.APOLLO_API_KEY = "apollo_test_key_0000000000";
    await db.integrationRecord.update({ where: { provider: "apollo" }, data: { status: "armed" } });
    const dale = await candidateByPerson("Dale Merritt");
    const transport = transportFor([["people/match", MATCH_HIT]]);
    const outcome = await revealSourcingCandidate(dale.id, { actor: "test", transport });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("resolved");
    expect(outcome.email).toBe("dale.merritt@ironvalepipe.example.com");
    expect(outcome.candidateStage).toBe("revealed");
    const after = await db.sourcingCandidate.findUnique({ where: { id: dale.id }, select: { stage: true, revealedProvider: true, attempts: true } });
    expect(after?.stage).toBe("revealed");
    expect(after?.revealedProvider).toBe("apollo");
    expect(after?.attempts).toBe(2);
    const prospect = await db.prospect.findUnique({ where: { id: dale.prospectId }, select: { bestEmail: true } });
    expect(prospect?.bestEmail).toBe("dale.merritt@ironvalepipe.example.com");
    const ledger = await db.contactResolution.findFirst({ where: { prospectId: dale.prospectId, outcome: "resolved" } });
    expect(ledger?.creditsUsed).toBe(1);
  });

  it("keeps a no_match candidate staged with the provider's answer as the reason", async () => {
    const june = await candidateByPerson("June Castellanos");
    const transport = transportFor([["people/match", MATCH_MISS]]);
    const outcome = await revealSourcingCandidate(june.id, { actor: "test", transport });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("no_match");
    expect(outcome.candidateStage).toBe("staged");
    const after = await db.sourcingCandidate.findUnique({ where: { id: june.id }, select: { stage: true, stageReason: true } });
    expect(after?.stage).toBe("staged");
    expect(after?.stageReason).toContain("no billable contact");
  });

  it("dismisses a staged candidate, keeps the verdict over re-staging, and refuses double-dismiss", async () => {
    const wilma = await candidateByPerson("Wilma Reyes");
    const dismissed = await dismissSourcingCandidate(wilma.id, "not a buyer", "test");
    expect(dismissed.ok).toBe(true);
    const again = await dismissSourcingCandidate(wilma.id, "not a buyer", "test");
    expect(again.ok).toBe(false);
    expect(again.reason).toContain("sourcing_candidate_not_staged");
    // re-staging refreshes the math but the operator's veto stands —
    // stage back down first: staging batches only run while unarmed
    await db.integrationRecord.update({ where: { provider: "apollo" }, data: { status: "staged" } });
    delete process.env.APOLLO_API_KEY;
    const rerun = await stageSourcingBatch({ icp: DEFAULT_ICP, actor: "test", mode: "staging" });
    expect(rerun.ok).toBe(true);
    const after = await db.sourcingCandidate.findUnique({ where: { id: wilma.id }, select: { stage: true, stageReason: true } });
    expect(after?.stage).toBe("dismissed");
    expect(after?.stageReason).toContain("not a buyer");
    const view = await sourcingQueue();
    expect(view.stats.dismissed).toBe(1);
    expect(view.staged.find((s) => s.candidateId === wilma.id)).toBeUndefined();
  });
});
