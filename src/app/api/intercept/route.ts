import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { toInterceptView } from '@/lib/backbone-service';

export const dynamic = 'force-dynamic';

/** GET /api/intercept — latest margin-defense events (polled every 2s). */
export async function GET() {
  await ensureDb();
  const events = await db.interceptEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  return NextResponse.json(events.map(toInterceptView));
}
