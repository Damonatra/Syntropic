import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';

export const dynamic = 'force-dynamic';

export interface SeasonScore {
  founder: string;
  fullName: string;
  defendedCents: number;
  entries: number;
  /** Share of the week's defended margin, 0–100. */
  sharePct: number;
}

export interface SeasonWeek {
  weekStart: string;
  winner: string | null;
  winnerCents: number;
  runnerUp: string | null;
  runnerUpCents: number;
}

export interface SeasonsView {
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  scores: SeasonScore[];
  leader: string | null;
  headToHeadCents: number;
  belt: { holder: string | null; weeksHeld: number };
  history: SeasonWeek[];
  computedAt: string;
}

const WEEK = 7 * 86_400_000;

/** Monday 00:00 UTC of the week containing `at`. */
function weekStartOf(at: Date): Date {
  const day = at.getUTCDay(); // 0 = Sun … 6 = Sat
  const backToMonday = (day + 6) % 7;
  const start = new Date(at);
  start.setUTCHours(0, 0, 0, 0);
  return new Date(start.getTime() - backToMonday * 86_400_000);
}

const weekLabel = (start: Date) =>
  `Week of ${start.toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
const dayLabel = (d: Date) => d.toISOString().slice(0, 10);

/**
 * GET /api/arena/seasons — the founder leaderboard becomes a running match
 * (Feature: arena seasons). Every MARGIN_DEFENDED ledger entry is credited to
 * the founder who owns its tenant (least-loaded assignment relation), bucketed
 * into ISO weeks (Mon–Sun UTC). The belt changes hands only when a week is
 * lost; streaks are honest arithmetic over the same rows, nothing hardcoded.
 */
export async function GET() {
  await ensureDb();

  const HISTORY_WEEKS = 6;
  const thisWeek = weekStartOf(new Date());
  const windowStart = new Date(thisWeek.getTime() - (HISTORY_WEEKS - 1) * WEEK);

  const [entries, tenants, team] = await Promise.all([
    db.ledgerEntry.findMany({
      where: { kind: 'MARGIN_DEFENDED', createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'asc' },
    }),
    db.tenant.findMany({ select: { name: true, owner: true, assignedToId: true } }),
    db.teamMember.findMany({ orderBy: { sortOrder: 'asc' } }),
  ]);

  // Credit map: tenant name → founder handle (assigned relation, falling back
  // to the owner string's first name for joint ownership like "Damon / Josias").
  const nameById = new Map(team.map((m) => [m.id, m.name]));
  const creditTo = new Map<string, string>();
  for (const t of tenants) {
    const viaAssignment = t.assignedToId ? nameById.get(t.assignedToId) : undefined;
    const viaOwner = t.owner.split('/')[0]?.trim();
    creditTo.set(t.name, viaAssignment ?? (team.some((m) => m.name === viaOwner) ? viaOwner! : 'House'));
  }

  const buckets = new Map<string, Map<string, { cents: number; entries: number }>>();
  for (const e of entries) {
    const ws = dayLabel(weekStartOf(e.createdAt));
    if (!buckets.has(ws)) buckets.set(ws, new Map());
    const week = buckets.get(ws)!;
    const founder = creditTo.get(e.tenantName) ?? 'House';
    const cell = week.get(founder) ?? { cents: 0, entries: 0 };
    cell.cents += e.amountCents;
    cell.entries += 1;
    week.set(founder, cell);
  }

  const thisKey = dayLabel(thisWeek);
  const currentWeek = buckets.get(thisKey) ?? new Map();
  const weekTotal = [...currentWeek.values()].reduce((s, c) => s + c.cents, 0);

  const scores: SeasonScore[] = team.map((m) => {
    const cell = currentWeek.get(m.name);
    return {
      founder: m.name,
      fullName: m.fullName || m.name,
      defendedCents: cell?.cents ?? 0,
      entries: cell?.entries ?? 0,
      sharePct: weekTotal > 0 ? Math.round(((cell?.cents ?? 0) / weekTotal) * 100) : 0,
    };
  }).sort((a, b) => b.defendedCents - a.defendedCents || b.entries - a.entries);

  const leader = scores[0] && scores[0].defendedCents > 0 ? scores[0].founder : null;
  const headToHeadCents = scores.length >= 2 ? scores[0].defendedCents - scores[1].defendedCents : scores[0]?.defendedCents ?? 0;

  // History — completed weeks only, oldest first.
  const history: SeasonWeek[] = [];
  for (let i = HISTORY_WEEKS - 1; i >= 1; i--) {
    const ws = dayLabel(new Date(thisWeek.getTime() - i * WEEK));
    const week = buckets.get(ws) ?? new Map();
    const ranked = [...week.entries()].sort((a, b) => b[1].cents - a[1].cents);
    history.push({
      weekStart: ws,
      winner: ranked[0] && ranked[0][1].cents > 0 ? ranked[0][0] : null,
      winnerCents: ranked[0]?.[1].cents ?? 0,
      runnerUp: ranked[1]?.[0] ?? null,
      runnerUpCents: ranked[1]?.[1].cents ?? 0,
    });
  }

  // The belt: held by the last completed week's winner; weeksHeld counts the
  // consecutive defenses walking back from that week (the current week can
  // extend the streak only once it's won — it isn't over yet).
  const lastCompleted = history[history.length - 1];
  let beltHolder = lastCompleted?.winner ?? null;
  let weeksHeld = 0;
  if (beltHolder) {
    weeksHeld = 1;
    for (let i = history.length - 2; i >= 0; i--) {
      if (history[i].winner === beltHolder) weeksHeld += 1;
      else break;
    }
  }

  const weekEnd = new Date(thisWeek.getTime() + 6 * 86_400_000);

  const view: SeasonsView = {
    weekStart: thisKey,
    weekEnd: dayLabel(weekEnd),
    weekLabel: weekLabel(thisWeek),
    scores,
    leader,
    headToHeadCents,
    belt: { holder: beltHolder, weeksHeld },
    history,
    computedAt: new Date().toISOString(),
  };

  return NextResponse.json(view);
}
