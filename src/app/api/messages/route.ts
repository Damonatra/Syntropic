import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { logCommand } from '@/lib/command-log';
import { emit } from '@/lib/bus';
import type { MessageView } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/messages — unified multi-tenant feed (R-06 ingestion surface). */
export async function GET() {
  await ensureDb();
  const rows = await db.message.findMany({ orderBy: { createdAt: 'asc' } });
  const view: MessageView[] = rows.map((m) => ({
    id: m.id,
    tenantName: m.tenantName,
    sender: m.sender,
    text: m.text,
    direction: m.direction === 'client' ? 'client' : 'team',
    unread: m.unread,
    createdAt: m.createdAt.toISOString(),
  }));
  return NextResponse.json(view);
}

/**
 * POST /api/messages — the same endpoint the future Executive Enclave
 * (Layer 3) will call to stream client messages into the Backbone.
 */
export async function POST(req: Request) {
  await ensureDb();
  const body = await req.json().catch(() => null);
  if (!body || typeof body.tenantName !== 'string' || typeof body.text !== 'string' || !body.text.trim()) {
    return NextResponse.json({ error: 'tenantName and text are required' }, { status: 400 });
  }
  const created = await db.message.create({
    data: {
      tenantName: body.tenantName,
      sender: typeof body.sender === 'string' && body.sender.trim() ? body.sender : 'Josias (Syntropic)',
      text: body.text.trim(),
      direction: 'team', // Task 23 — the tower always writes the team side; no client-side guessing
      unread: body.sender ? body.unread === true : false,
    },
  });
  await logCommand({
    actor: typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'Josias',
    action: 'MESSAGE_SENT',
    target: body.tenantName,
    detail: `direct enclave line — “${body.text.trim().slice(0, 120)}${body.text.trim().length > 120 ? '…' : ''}”`,
  });
  // Direct-line presence (Task 19) — the client's enclave reacts without polling.
  emit({
    type: 'message',
    tenantName: body.tenantName,
    direction: 'team',
    sender: typeof body.sender === 'string' && body.sender.trim() ? body.sender : 'Josias (Syntropic)',
    text: body.text.trim(),
  });
  return NextResponse.json({ id: created.id }, { status: 201 });
}
