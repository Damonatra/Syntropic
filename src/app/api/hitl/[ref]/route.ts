import { NextResponse } from 'next/server';
import { applyHitlAction } from '@/lib/backbone-service';
import type { HitlAction } from '@/lib/types';

export const dynamic = 'force-dynamic';

const ACTIONS: HitlAction[] = ['APPROVE', 'OVERRIDE', 'RETRY', 'RESOLVE', 'NOTIFY'];

/**
 * PATCH /api/hitl/[ref] — HITL resolution actions.
 * APPROVE runs the draft-dispatch mailbox gate: ACTIVE mailboxes proceed
 * (margin lands on the ledger); LOCKED/MISSING mailboxes spawn a
 * DispatchFailure HITL item routed to the tenant owner (R-03).
 * OVERRIDE accepts { sku } — the operator's corrected reading, stored on the
 * item and logged before → after (Task 22). NOTIFY re-sends the owner's
 * Telegram action card and reports the real delivery status.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  const body = await req.json().catch(() => null);
  const action = body?.action as HitlAction;
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ error: `action must be one of ${ACTIONS.join(', ')}` }, { status: 400 });
  }
  // Actor attribution for the Ship's Log — the Tower signs every command.
  const actor = typeof body?.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'Telegram operator';
  const correction =
    action === 'OVERRIDE' && typeof body?.sku === 'string' && body.sku.trim() ? { sku: body.sku } : undefined;
  const result = await applyHitlAction(decodeURIComponent(ref), action, actor, correction);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json(result);
}
