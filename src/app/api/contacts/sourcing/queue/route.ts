/**
 * GET /api/contacts/sourcing/queue — the reveal queue's read model.
 *
 * Staged candidates ranked by fit, revealed kept for the record, dismissed
 * counted but not shown. The stats block carries the below-bar count so the
 * panel can say honestly why the queue is thin.
 */
import { NextResponse } from "next/server";
import { sourcingQueue } from "@/lib/vertebra/sourcing";

export async function GET() {
  const view = await sourcingQueue();
  return NextResponse.json({ ok: true, ...view }, { headers: { "cache-control": "no-store" } });
}
