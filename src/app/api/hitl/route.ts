import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { createOcrHitl, toHitlView } from '@/lib/backbone-service';

export const dynamic = 'force-dynamic';

/** GET /api/hitl — full human-in-the-loop queue (OCR + dispatch failures). */
export async function GET() {
  await ensureDb();
  const items = await db.hitlItem.findMany({ orderBy: { createdAt: 'asc' } });
  return NextResponse.json(items.map(toHitlView));
}

/**
 * POST /api/hitl — generic ingestion endpoint for upstream OCR pipeline.
 * Low-confidence items (<95) are auto-enqueued and pushed to Telegram
 * with inline Approve/Override keyboards (R-05).
 */
export async function POST(req: Request) {
  await ensureDb();
  const body = await req.json().catch(() => null);
  if (!body || typeof body.tenantName !== 'string' || typeof body.skuParsed !== 'string') {
    return NextResponse.json({ error: 'tenantName and skuParsed are required' }, { status: 400 });
  }
  const confidence = typeof body.confidenceScore === 'number' ? body.confidenceScore : 0;
  const lossCents = typeof body.extractedMarginLossCents === 'number' ? Math.round(body.extractedMarginLossCents) : 0;
  const result = await createOcrHitl({
    tenantName: body.tenantName,
    pdfName: typeof body.pdfName === 'string' ? body.pdfName : undefined,
    skuParsed: body.skuParsed,
    confidenceScore: confidence,
    extractedMarginLossCents: lossCents,
  });
  return NextResponse.json(result, { status: 201 });
}
