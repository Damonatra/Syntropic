import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { emit } from '@/lib/bus';

export const dynamic = 'force-dynamic';

/** POST /api/messages/read — mark a tenant thread as read (X-3). */
export async function POST(req: Request) {
  await ensureDb();
  const body = await req.json().catch(() => null);
  if (!body || typeof body.tenantName !== 'string') {
    return NextResponse.json({ error: 'tenantName is required' }, { status: 400 });
  }
  const res = await db.message.updateMany({
    where: { tenantName: body.tenantName, unread: true },
    data: { unread: false, readAt: new Date() },
  });
  // Task 19 — the client's enclave lights its "Seen" receipt without polling.
  if (res.count > 0) emit({ type: 'thread-read', tenantName: body.tenantName, cleared: res.count });
  return NextResponse.json({ cleared: res.count });
}
