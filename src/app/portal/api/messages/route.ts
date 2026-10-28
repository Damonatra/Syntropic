import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sessionTenant } from '@/lib/portal-session';
import { emit } from '@/lib/bus';
import type { MessageView } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Portal-side direct line (R-06) — session-scoped twin of /api/messages.
 * The client identity is server-derived from the session (epoch-checked:
 * rotated/revoked invites kill live sessions) — a logged-in enclave can only
 * read and write its own thread. Messages from the client always arrive
 * unread-flagged so the Backbone inbox surfaces the dot.
 */

/** GET — this tenant's thread only. */
export async function GET() {
  const tenant = await sessionTenant();
  if (!tenant) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  const rows = await db.message.findMany({
    where: { tenantName: tenant.name },
    orderBy: { createdAt: 'asc' },
  });
  const view: MessageView[] = rows.map((m) => ({
    id: m.id,
    tenantName: m.tenantName,
    sender: m.sender,
    text: m.text,
    direction: m.direction === 'client' ? 'client' : 'team',
    unread: m.unread,
    readAt: m.readAt ? m.readAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  }));
  return NextResponse.json(view);
}

/** POST { text } — tenant, sender identity and unread flag come from the session. */
export async function POST(req: Request) {
  const tenant = await sessionTenant();
  if (!tenant) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }

  const created = await db.message.create({
    data: {
      tenantName: tenant.name,
      sender: `Client (${tenant.contactName || 'Client'})`,
      text,
      direction: 'client', // Task 23 — the session IS the client identity; the server stamps it
      unread: true, // surfaces as the unread dot in the Backbone unified inbox
    },
  });
  // Direct-line presence (Task 19) — the team's tower reacts without polling.
  emit({ type: 'message', tenantName: tenant.name, direction: 'client', sender: `Client (${tenant.contactName || 'Client'})`, text });
  return NextResponse.json({ id: created.id }, { status: 201 });
}
