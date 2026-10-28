import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import type { CommandLogView } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/command-log — the Ship's Log feed (latest first).
 * Append-only: rows are never edited or deleted; the tower renders them
 * as an attributed editorial chronology.
 * Time travel: ?asOf=<ISO> shows the journal as it stood at that instant.
 */
export async function GET(req: Request) {
  await ensureDb();

  const params = new URL(req.url).searchParams;
  const limitParam = Number(params.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(200, Math.round(limitParam)) : 60;

  const asOfMs = Date.parse(params.get('asOf') ?? '');
  const asOf = Number.isFinite(asOfMs) && asOfMs <= Date.now() ? new Date(asOfMs) : null;

  const rows = await db.commandLog.findMany({
    where: asOf ? { createdAt: { lte: asOf } } : undefined,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const view: CommandLogView[] = rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    action: r.action,
    target: r.target,
    detail: r.detail,
    createdAt: r.createdAt.toISOString(),
  }));

  return NextResponse.json(view);
}
