import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { logCommand } from '@/lib/command-log';
import { SCHEDULE_STATUSES, atRiskReasons, detectProvider, toSessionView } from '@/lib/schedule';
import type { ScheduleStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/calls/[id] — move, re-sign, re-host, attach a line, verify
 * attendance, flag for follow-up, or walk a block through its lifecycle.
 * Every meaningful change lands as ONE attributed row in the Ship's Log.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ensureDb();
  const { id } = await ctx.params;
  const row = await db.callSession.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: 'Engagement not found' }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const actor = typeof body.actor === 'string' && body.actor ? body.actor : 'Command deck';

  const changes: string[] = [];
  const data: {
    scheduledAt?: Date; endsAt?: Date; status?: string; hostId?: string | null;
    joinUrl?: string | null; provider?: string | null; notes?: string;
    flagged?: boolean; attendanceVerified?: boolean; verifiedAt?: Date;
  } = {};

  // Move (reschedule) — start and/or end.
  if (body.scheduledAt !== undefined) {
    const ms = Date.parse(String(body.scheduledAt));
    if (!Number.isFinite(ms)) return NextResponse.json({ error: 'scheduledAt must be an ISO date' }, { status: 422 });
    if (ms !== row.scheduledAt.getTime()) {
      data.scheduledAt = new Date(ms);
      const newEnd = body.endsAt !== undefined
        ? Date.parse(String(body.endsAt))
        : row.endsAt
          ? ms + (row.endsAt.getTime() - row.scheduledAt.getTime())
          : ms + 30 * 60_000;
      if (!Number.isFinite(newEnd) || newEnd <= ms) return NextResponse.json({ error: 'endsAt must be after scheduledAt' }, { status: 422 });
      data.endsAt = new Date(newEnd);
      changes.push(`moved to ${data.scheduledAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`);
    } else if (body.endsAt !== undefined) {
      const endMs = Date.parse(String(body.endsAt));
      if (!Number.isFinite(endMs) || endMs <= ms) return NextResponse.json({ error: 'endsAt must be after scheduledAt' }, { status: 422 });
      if (endMs !== (row.endsAt?.getTime() ?? 0)) {
        data.endsAt = new Date(endMs);
        changes.push('duration adjusted');
      }
    }
  } else if (body.endsAt !== undefined) {
    const endMs = Date.parse(String(body.endsAt));
    if (!Number.isFinite(endMs) || endMs <= row.scheduledAt.getTime()) {
      return NextResponse.json({ error: 'endsAt must be after scheduledAt' }, { status: 422 });
    }
    if (endMs !== (row.endsAt?.getTime() ?? 0)) {
      data.endsAt = new Date(endMs);
      changes.push('duration adjusted');
    }
  }

  // Lifecycle.
  if (body.status !== undefined) {
    const status = String(body.status);
    if (!SCHEDULE_STATUSES.includes(status as ScheduleStatus)) {
      return NextResponse.json({ error: `status must be one of ${SCHEDULE_STATUSES.join(', ')}` }, { status: 422 });
    }
    if (status !== row.status) {
      data.status = status;
      changes.push(`${row.status} → ${status}`);
    }
  }

  // Re-host.
  if (body.hostId !== undefined) {
    const nextHostId = typeof body.hostId === 'string' && body.hostId ? body.hostId : null;
    if (nextHostId !== row.hostId) {
      if (nextHostId) {
        const host = await db.teamMember.findUnique({ where: { id: nextHostId } });
        if (!host) return NextResponse.json({ error: 'Unknown hostId' }, { status: 422 });
        data.hostId = nextHostId;
        changes.push(`host → ${host.name}`);
      } else {
        data.hostId = null;
        changes.push('host cleared — needs cover');
      }
    }
  }

  // Tier-1 join line: paste, replace, or remove.
  if (body.joinUrl !== undefined) {
    const url = typeof body.joinUrl === 'string' && body.joinUrl.trim() ? body.joinUrl.trim() : null;
    if (url !== row.joinUrl) {
      data.joinUrl = url;
      data.provider = url ? detectProvider(url) : row.isInternal ? 'ENCLAVE' : null;
      changes.push(url ? `${data.provider} line attached` : 'join line removed');
    }
  }

  if (body.notes !== undefined && typeof body.notes === 'string' && body.notes !== row.notes) {
    data.notes = body.notes.slice(0, 2000);
    changes.push('notes updated');
  }

  if (body.flagged !== undefined && typeof body.flagged === 'boolean' && body.flagged !== row.flagged) {
    data.flagged = body.flagged;
    changes.push(body.flagged ? 'flagged for follow-up' : 'follow-up flag cleared');
  }

  // Proof of presence — the EVV analog. One-way latch, stamped the moment it happens.
  if (body.attendanceVerified === true && !row.attendanceVerified) {
    data.attendanceVerified = true;
    data.verifiedAt = new Date();
    changes.push('attendance verified');
  }

  if (!changes.length) {
    return NextResponse.json({ session: toSessionView(row, await hostNameOf(row.hostId), []) });
  }

  const updated = await db.callSession.update({ where: { id }, data });

  const action =
    data.hostId !== undefined ? 'REASSIGNED'
    : data.status !== undefined ? 'STATUS_CHANGED'
    : data.scheduledAt !== undefined || data.endsAt !== undefined ? 'RESCHEDULED'
    : data.attendanceVerified ? 'ATTENDANCE_VERIFIED'
    : data.joinUrl !== undefined ? 'LINK_ATTACHED'
    : 'STATUS_CHANGED';

  logCommand({ actor, action, target: row.clientName, detail: changes.join(' · ') });

  const atRisk = atRiskReasons(
    updated,
    new Map((await db.tenant.findMany({ select: { name: true, paymentStatus: true, mailboxStatus: true } })).map((t) => [t.name, t])),
    new Set((await db.hitlItem.findMany({ where: { status: 'PENDING', createdAt: { lte: new Date(Date.now() - 24 * 3_600_000) } }, select: { tenantName: true } })).map((h) => h.tenantName)),
  );

  return NextResponse.json({ session: toSessionView(updated, await hostNameOf(updated.hostId), atRisk) });
}

async function hostNameOf(hostId: string | null): Promise<string | null> {
  if (!hostId) return null;
  const host = await db.teamMember.findUnique({ where: { id: hostId }, select: { name: true, fullName: true } });
  return host ? host.fullName || host.name : null;
}
