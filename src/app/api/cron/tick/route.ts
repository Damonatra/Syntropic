/**
 * POST /api/cron/tick — engine/cron entry to the sequence engine.
 * Auth: ingest key (the Python engine or an external cron calls this).
 * The operator-facing entry is /api/ops/tick.
 */
import { NextResponse } from "next/server";
import { guardWrite } from "@/lib/vertebra/guard";
import { runSequenceTick } from "@/lib/vertebra/tick";

export async function POST(request: Request) {
  const denied = guardWrite(request, "cron/tick", { limit: 12, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const outcome = await runSequenceTick();
    return NextResponse.json({ ok: true, tickedAt: new Date().toISOString(), ...outcome });
  } catch (error) {
    console.error("[api/cron/tick] failed", error);
    return NextResponse.json({ error: "tick_failed" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
