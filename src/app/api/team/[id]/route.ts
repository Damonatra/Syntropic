import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { logCommand } from '@/lib/command-log';
import type { TeamMemberView } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/team/[id] — persist a quarterly outbound target adjustment.
 * Only the target is mutable; performance counters are engine-reported.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await ensureDb();
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const target = Number(body?.qOutboundTarget);
  if (!Number.isFinite(target) || target < 1 || target > 1_000_000) {
    return NextResponse.json({ error: 'qOutboundTarget must be a number between 1 and 1,000,000' }, { status: 400 });
  }

  const existing = await db.teamMember.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: `Unknown team member ${id}` }, { status: 404 });

  const updated = await db.teamMember.update({
    where: { id },
    data: { qOutboundTarget: Math.round(target) },
  });

  await logCommand({
    actor: typeof body?.actor === 'string' && body.actor.trim() ? body.actor.trim() : existing.name,
    action: 'TARGET_ADJUSTED',
    target: updated.fullName || updated.name,
    detail: `quarterly outbound target moved ${existing.qOutboundCompleted.toLocaleString()} / ${existing.qOutboundTarget.toLocaleString()} → ${existing.qOutboundCompleted.toLocaleString()} / ${updated.qOutboundTarget.toLocaleString()}`,
  });

  const view: TeamMemberView = {
    id: updated.id,
    name: updated.name,
    fullName: updated.fullName || updated.name,
    role: updated.role,
    isOnline: updated.isOnline,
    qOutboundTarget: updated.qOutboundTarget,
    qOutboundCompleted: updated.qOutboundCompleted,
    discoveryCalls: updated.discoveryCalls,
    auditsClosed: updated.auditsClosed,
    contractsConverted: updated.contractsConverted,
    tone: 'steel',
  };
  return NextResponse.json({ ok: true, member: view });
}
