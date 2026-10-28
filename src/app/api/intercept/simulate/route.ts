import { NextResponse } from 'next/server';
import { simulateRfq } from '@/lib/backbone-service';

export const dynamic = 'force-dynamic';

/**
 * POST /api/intercept/simulate — deterministic inbound-RFQ engine cycling
 * five scenarios (normal defense ×3, HIGH-VALUE > $2,500, low-confidence OCR).
 * High-value events fire the Telegram alert server-side (R-04).
 * The triggering operator is attributed in the Ship's Log.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const actor = typeof body?.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'Engine';
  const result = await simulateRfq(actor);
  return NextResponse.json(result, { status: 201 });
}
