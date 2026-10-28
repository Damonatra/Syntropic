import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { logCommand } from '@/lib/command-log';
import { TERMINAL_STATUSES, dayRange, timeLabel } from '@/lib/schedule';
import type { AbsenceReason, FounderAbsenceView } from '@/lib/types';

export const dynamic = 'force-dynamic';

const REASONS: AbsenceReason[] = ['SICK', 'TRAVEL', 'FOCUS', 'OTHER'];

/**
 * POST /api/calls/absence — a founder goes dark for the day. The remaining
 * (non-terminal, not-yet-started) engagements immediately reassign through
 * the least-loaded available founder, and the banner prints both timestamps:
 * "reported 2:14 PM — 3 engagements reassigned to Josias at 2:15 PM".
 * Nothing is hidden: the sentence lands in the Ship's Log verbatim.
 */
export async function POST(req: Request) {
  await ensureDb();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const memberId = typeof body.memberId === 'string' ? body.memberId : '';
  const reason = REASONS.includes(body.reason as AbsenceReason) ? (body.reason as AbsenceReason) : null;
  if (!memberId) return NextResponse.json({ error: 'memberId is required' }, { status: 422 });
  if (!reason) return NextResponse.json({ error: `reason must be one of ${REASONS.join(', ')}` }, { status: 422 });

  const member = await db.teamMember.findUnique({ where: { id: memberId } });
  if (!member) return NextResponse.json({ error: 'Unknown memberId' }, { status: 404 });

  const day = typeof body.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.day)
    ? body.day
    : new Date().toISOString().slice(0, 10);
  const { start: dayStart, end: dayEnd } = dayRange(day);

  // One active absence per founder per day — idempotent, like a real outage.
  const existing = await db.founderAbsence.findFirst({ where: { memberId, day, resolvedAt: null } });
  if (existing) return NextResponse.json({ absence: toView(existing, member), moved: 0, toName: null });

  // Candidates: today's remaining engagements owned by the absent founder.
  const now = new Date();
  const candidates = await db.callSession.findMany({
    where: {
      hostId: memberId,
      scheduledAt: { gte: new Date(Math.max(dayStart.getTime(), now.getTime())), lt: dayEnd },
      status: { notIn: [...TERMINAL_STATUSES] },
    },
    orderBy: { scheduledAt: 'asc' },
  });

  // Least-loaded available founder: no active absence today, fewest remaining
  // engagements for the day, tie-broken by roster order.
  const roster = await db.teamMember.findMany({ orderBy: { sortOrder: 'asc' } });
  const activeAbsences = await db.founderAbsence.findMany({ where: { day, resolvedAt: null } });
  const absentIds = new Set([...activeAbsences.map((a) => a.memberId), memberId]);
  const pool = roster.filter((m) => !absentIds.has(m.id));

  let target: (typeof roster)[number] | null = null;
  let moved = 0;
  if (pool.length) {
    const loads = new Map<string, number>();
    for (const m of pool) loads.set(m.id, 0);
    for (const s of candidates) if (loads.has(s.hostId ?? '')) loads.set(s.hostId!, (loads.get(s.hostId!) ?? 0) + 1);
    // Load the candidate's own count onto each helper AFTER redistribution —
    // with two founders the helper simply absorbs everything; with more, the
    // base load (their own remaining day) keeps the split honest.
    const baseLoad = new Map<string, number>();
    const others = await db.callSession.findMany({
      where: { hostId: { in: pool.map((m) => m.id) }, scheduledAt: { gte: now, lt: dayEnd }, status: { notIn: [...TERMINAL_STATUSES] } },
      select: { hostId: true },
    });
    for (const o of others) baseLoad.set(o.hostId!, (baseLoad.get(o.hostId!) ?? 0) + 1);
    target = [...pool].sort(
      (a, b) => (baseLoad.get(a.id) ?? 0) - (baseLoad.get(b.id) ?? 0) || a.sortOrder - b.sortOrder,
    )[0];

    const movedRes = await db.callSession.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: { hostId: target.id },
    });
    moved = movedRes.count;
  }

  const reportedAt = new Date();
  const sentence = target
    ? moved > 0
      ? `${moved} engagement${moved === 1 ? '' : 's'} reassigned to ${target.fullName || target.name} at ${timeLabel(reportedAt)}`
      : 'Nothing needed cover — the rest of the day was already clear'
    : 'No available founder — the remaining engagements need manual cover';

  const absence = await db.founderAbsence.create({
    data: { memberId, reason, note: typeof body.note === 'string' ? body.note.slice(0, 500) : '', day, reportedAt, reassignments: sentence },
  });

  logCommand({
    actor: typeof body.actor === 'string' && body.actor ? body.actor : 'Command deck',
    action: 'FOUNDER_UNAVAILABLE',
    target: member.name,
    detail: `${reason.toLowerCase()} · reported ${timeLabel(reportedAt)} — ${sentence}`,
  });

  return NextResponse.json({ absence: toView(absence, member), moved, toName: target ? target.fullName || target.name : null }, { status: 201 });
}

/**
 * PATCH /api/calls/absence — the founder is back. The day is NOT un-done
 * (blocks stay where they were handled — the ledger never rewrites history);
 * the absence just closes with a timestamp.
 */
export async function PATCH(req: Request) {
  await ensureDb();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = body && typeof body.id === 'string' ? body.id : '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 422 });

  const absence = await db.founderAbsence.findUnique({ where: { id } });
  if (!absence) return NextResponse.json({ error: 'Absence not found' }, { status: 404 });
  if (absence.resolvedAt) return NextResponse.json({ absence: toView(absence) });

  const member = await db.teamMember.findUnique({ where: { id: absence.memberId } });
  const resolvedAt = new Date();
  const updated = await db.founderAbsence.update({ where: { id }, data: { resolvedAt } });

  logCommand({
    actor: body && typeof body.actor === 'string' && body.actor ? body.actor : 'Command deck',
    action: 'FOUNDER_RETURNED',
    target: member?.name ?? absence.memberId,
    detail: `back at ${timeLabel(resolvedAt)} — engagements stay where they were handled`,
  });

  return NextResponse.json({ absence: toView(updated, member) });
}

function toView(a: { id: string; memberId: string; reason: string; note: string; day: string; reportedAt: Date; resolvedAt: Date | null; reassignments: string }, member?: { name: string; fullName: string } | null): FounderAbsenceView {
  return {
    id: a.id,
    memberId: a.memberId,
    memberName: member ? member.fullName || member.name : a.memberId,
    reason: a.reason as AbsenceReason,
    note: a.note,
    day: a.day,
    reportedAt: a.reportedAt.toISOString(),
    resolvedAt: a.resolvedAt ? a.resolvedAt.toISOString() : null,
    reassignments: a.reassignments,
  };
}
