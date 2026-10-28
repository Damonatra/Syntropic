import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { logCommand } from '@/lib/command-log';
import { atRiskReasons, detectProvider, toSessionView } from '@/lib/schedule';
import type { FounderAbsenceView, ScheduleBoardView, ScheduleSessionView } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/calls — the operating-day board: every engagement (client-facing
 * and internal) plus every active founder absence. AT-RISK is earned here,
 * server-side, from live tenant state — the grid never invents distress.
 */
export async function GET() {
  await ensureDb();

  const [rows, members, tenants, agingHitl, absences] = await Promise.all([
    db.callSession.findMany({ orderBy: { scheduledAt: 'asc' } }),
    db.teamMember.findMany({ select: { id: true, name: true, fullName: true } }),
    db.tenant.findMany({ select: { name: true, paymentStatus: true, mailboxStatus: true } }),
    db.hitlItem.findMany({
      where: { status: 'PENDING', createdAt: { lte: new Date(Date.now() - 24 * 3_600_000) } },
      select: { tenantName: true },
    }),
    db.founderAbsence.findMany({ where: { resolvedAt: null }, orderBy: { reportedAt: 'desc' } }),
  ]);

  const memberNames = new Map(members.map((m) => [m.id, m.fullName || m.name]));
  const tenantByName = new Map(tenants.map((t) => [t.name, t]));
  const agingHitlTenants = new Set(agingHitl.map((h) => h.tenantName));

  const sessions: ScheduleSessionView[] = rows.map((row) =>
    toSessionView(
      row,
      row.hostId ? (memberNames.get(row.hostId) ?? null) : null,
      atRiskReasons(row, tenantByName, agingHitlTenants),
    ),
  );

  const absenceViews: FounderAbsenceView[] = absences.map((a) => ({
    id: a.id,
    memberId: a.memberId,
    memberName: memberNames.get(a.memberId) ?? 'Founder',
    reason: a.reason as FounderAbsenceView['reason'],
    note: a.note,
    day: a.day,
    reportedAt: a.reportedAt.toISOString(),
    resolvedAt: a.resolvedAt ? a.resolvedAt.toISOString() : null,
    reassignments: a.reassignments,
  }));

  const board: ScheduleBoardView = { sessions, absences: absenceViews };
  return NextResponse.json(board);
}

/**
 * POST /api/calls — schedule an engagement (client-facing or internal).
 * Paste a Zoom/Meet link at creation (Tier 1) or attach one later.
 */
export async function POST(req: Request) {
  await ensureDb();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const clientName = typeof body.clientName === 'string' ? body.clientName.trim() : '';
  const type = typeof body.type === 'string' ? body.type.trim() : '';
  const scheduledAtMs = Date.parse(String(body.scheduledAt ?? ''));
  if (!clientName) return NextResponse.json({ error: 'clientName is required' }, { status: 422 });
  if (!type) return NextResponse.json({ error: 'type is required' }, { status: 422 });
  if (!Number.isFinite(scheduledAtMs)) return NextResponse.json({ error: 'scheduledAt must be an ISO date' }, { status: 422 });

  const isInternal = Boolean(body.isInternal);
  const hostId = typeof body.hostId === 'string' && body.hostId ? body.hostId : null;
  if (hostId && !(await db.teamMember.findUnique({ where: { id: hostId } }))) {
    return NextResponse.json({ error: 'Unknown hostId' }, { status: 422 });
  }

  const scheduledAt = new Date(scheduledAtMs);
  const endsAt = Number.isFinite(Date.parse(String(body.endsAt ?? '')))
    ? new Date(Date.parse(String(body.endsAt)))
    : new Date(scheduledAtMs + 30 * 60_000);
  if (endsAt.getTime() <= scheduledAt.getTime()) {
    return NextResponse.json({ error: 'endsAt must be after scheduledAt' }, { status: 422 });
  }

  const joinUrl = typeof body.joinUrl === 'string' && body.joinUrl.trim() ? body.joinUrl.trim() : null;
  const provider = joinUrl ? detectProvider(joinUrl) : isInternal ? 'ENCLAVE' : null;

  const created = await db.callSession.create({
    data: {
      clientName,
      type,
      scheduledAt,
      endsAt,
      status: 'SCHEDULED',
      hostId,
      joinUrl,
      provider,
      notes: typeof body.notes === 'string' ? body.notes.slice(0, 2000) : '',
      isInternal,
    },
  });

  const host = hostId ? await db.teamMember.findUnique({ where: { id: hostId } }) : null;
  logCommand({
    actor: typeof body.actor === 'string' && body.actor ? body.actor : 'Command deck',
    action: 'SCHEDULED',
    target: clientName,
    detail: `${type} · ${scheduledAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${
      host ? ` · host ${host.name}` : ''
    }${joinUrl ? ` · ${provider} line attached` : ''}`,
  });

  return NextResponse.json({ session: toSessionView(created, host ? host.fullName || host.name : null, []) }, { status: 201 });
}
