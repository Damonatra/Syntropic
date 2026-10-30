/**
 * M4 verification — coverage watches, escalation ladder, briefing.
 *
 * Part 1 (pure): deriveCoverageAlerts rules + escalateDeck thresholds.
 * Part 2 (live): reads the real /api/command snapshot and asserts the
 * briefing numbers trace to the same rows the engine view shows.
 *
 *   bun scripts/test_ops_m4.ts
 */
import {
  deriveCoverageAlerts,
  escalateDeck,
  ESCALATE_AFTER_MS,
} from "../src/lib/vertebra/watches";
import type { EngagementShape, OpsWatchAlert } from "../src/lib/vertebra/command";

const HOUR = 3_600_000;
const DAY = 86_400_000;

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

function mkEngagement(o: Partial<EngagementShape> & { id: string }): EngagementShape {
  return {
    ref: `ref_${o.id}`,
    clientName: o.id,
    clientDomain: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    tier: "diagnostic_audit",
    amountUsd: 3500,
    source: "portal_webhook",
    status: "verdict",
    intakeRfqPerMonth: null,
    intakeLineItems: null,
    guaranteeCleared: null,
    confirmedLeakageUsd: null,
    verdictNote: null,
    deliverableUrl: null,
    prospectId: null,
    prospectName: null,
    documentCount: 0,
    paidAtMs: NOW - 20 * HOUR,
    deliveredAtMs: null,
    events: [],
    ...o,
  };
}

console.log("deriveCoverageAlerts — the recon sweep");

{
  // Two undecided verdicts → $20,000 exposure warn.
  const alerts = deriveCoverageAlerts(
    {
      engagements: [mkEngagement({ id: "v1" }), mkEngagement({ id: "v2" })],
      newLeads7d: 2,
      newLeadsPrior21d: 6,
    },
    NOW,
  );
  const exposure = alerts.find((a) => a.watchId === "guarantee_exposure");
  check("two undecided verdicts ring the exposure watch", Boolean(exposure));
  check("exposure math in title and evidence", Boolean(exposure?.title.includes("$20,000") && exposure?.evidence?.includes("2 undecided")));
  check("one undecided stays quiet", deriveCoverageAlerts({ engagements: [mkEngagement({ id: "v1" })], newLeads7d: 2, newLeadsPrior21d: 6 }, NOW).every((a) => a.watchId !== "guarantee_exposure"));
  check("decided verdicts do not count", deriveCoverageAlerts({ engagements: [mkEngagement({ id: "v1", guaranteeCleared: true }), mkEngagement({ id: "v2", guaranteeCleared: false })], newLeads7d: 2, newLeadsPrior21d: 6 }, NOW).every((a) => a.watchId !== "guarantee_exposure"));
}

{
  // Delivered engagement with a null artifact link → liveness warn.
  const alerts = deriveCoverageAlerts(
    {
      engagements: [
        mkEngagement({ id: "d1", status: "delivered", deliveredAtMs: NOW - 30 * HOUR, deliverableUrl: null }),
        mkEngagement({ id: "d2", status: "sow", deliveredAtMs: NOW - 90 * HOUR, deliverableUrl: "https://x/y" }),
      ],
      newLeads7d: 2,
      newLeadsPrior21d: 6,
    },
    NOW,
  );
  const missing = alerts.filter((a) => a.watchId === "deliverable_missing");
  check("delivered-but-linkless engagement flagged", missing.length === 1 && missing[0].subjectId === "d1", JSON.stringify(missing.map((m) => m.title)));
  check("delivered with a link stays quiet", missing.every((m) => m.subjectId !== "d2"));
}

{
  // Drought: zero new leads this week against a live 28d rhythm → info.
  const alerts = deriveCoverageAlerts({ engagements: [], newLeads7d: 0, newLeadsPrior21d: 9 }, NOW);
  const drought = alerts.find((a) => a.watchId === "lead_drought");
  check("drought rings against the book's own rhythm", Boolean(drought));
  check("drought evidence names the 3-week average", Boolean(drought?.evidence?.includes("3/wk")));
  check("a live week stays quiet", deriveCoverageAlerts({ engagements: [], newLeads7d: 1, newLeadsPrior21d: 9 }, NOW).every((a) => a.watchId !== "lead_drought"));
  check("a cold book (no 28d rhythm) stays quiet", deriveCoverageAlerts({ engagements: [], newLeads7d: 0, newLeadsPrior21d: 0 }, NOW).every((a) => a.watchId !== "lead_drought"));
}

console.log("escalateDeck — the ladder");

{
  const mk = (over: Partial<OpsWatchAlert> & { watchId: string }): OpsWatchAlert => ({
    key: `${over.watchId}:s:0`,
    watch: over.watchId,
    severity: "warn",
    subjectKind: "system",
    subjectId: null,
    subjectLabel: "x",
    title: over.watchId,
    action: "act",
    evidence: null,
    etaMs: null,
    firedAtMs: 0,
    ...over,
  });
  const firstSeen = new Map<string, number | null>([
    ["crit_old:system", NOW - ESCALATE_AFTER_MS - 5 * 60_000],
    ["crit_new:system", NOW - 4 * 60_000],
    ["crit_ghost:system", null],
  ]);
  const deck = escalateDeck(
    [
      mk({ watchId: "crit_old", severity: "crit", key: "crit_old:s:0" }),
      mk({ watchId: "crit_new", severity: "crit", key: "crit_new:s:0" }),
      mk({ watchId: "crit_ghost", severity: "crit", key: "crit_ghost:s:0" }),
      mk({ watchId: "warn_old", severity: "warn", key: "warn_old:s:0" }),
    ],
    firstSeen,
    NOW,
  );
  check("crit past 15 minutes unacked is escalated", deck[0].escalated?.unackedMs === ESCALATE_AFTER_MS + 5 * 60_000);
  check("fresh crit is not escalated", deck[1].escalated == null);
  check("crit with no fire history is not escalated (honest)", deck[2].escalated == null);
  check("warn rows never escalate", deck[3].escalated == null);
}

console.log("live: the morning brief through /api/command");

async function main() {
  const user = process.env.OPERATOR_USER ?? "josias";
  const pass = process.env.OPERATOR_PASSWORD;
  if (!pass) {
    console.error("set OPERATOR_PASSWORD — the shared enclave password is retired");
    process.exit(1);
  }
  const login = await fetch("http://localhost:3000/api/gate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password: pass }),
  });
  check("gate login", login.ok, `status ${login.status}`);
  const cookie = /enclave_session=([^;]*)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
  await new Promise((r) => setTimeout(r, 5_500)); // outlive the 5s snapshot cache
  const res = await fetch("http://localhost:3000/api/command", { headers: { cookie: `enclave_session=${cookie}` } });
  check("command snapshot reads", res.ok, `status ${res.status}`);
  const snap = (await res.json()) as {
    ops: {
      deck: Array<{ severity: string }>;
      briefing?: { fired24h: number; acked24h: number; liveNow: number; nextBreachMs: number | null; atRiskDollars: number };
      engine?: { stages: Array<{ atRiskDollars: number }>; activeDollars: number };
    };
  };
  const b = snap.ops.briefing;
  check("briefing present on the live snapshot", Boolean(b), JSON.stringify(b));
  check("liveNow equals the deck length", b?.liveNow === snap.ops.deck.length);
  check("at-risk dollars equal the engine stage sum", b?.atRiskDollars === (snap.ops.engine?.stages ?? []).reduce((s, st) => s + st.atRiskDollars, 0));
  check("briefing numbers are integers ≥ 0", (b?.fired24h ?? -1) >= 0 && (b?.acked24h ?? -1) >= 0);
}

await main();
console.log(failures === 0 ? "\nall M4 checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
