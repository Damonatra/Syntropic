/**
 * POST /api/cron/tick — engine/cron entry to the loop closers.
 * Auth: ingest key (an external cron calls this). The operator-facing entry
 * is /api/ops/tick. Both loops close on one call; the in-process scheduler
 * (instrumentation.ts) additionally runs the turnaround loop on its declared
 * cadence, so this route remains the entry for external orchestrators only.
 */
import { NextResponse } from "next/server";
import { guardWrite } from "@/lib/vertebra/guard";
import { runSequenceTick, runTurnaroundTick } from "@/lib/vertebra/tick";

export async function POST(request: Request) {
  const denied = guardWrite(request, "cron/tick", { limit: 12, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const sequence = await runSequenceTick();
    const turnaround = await runTurnaroundTick();
    return NextResponse.json({
      ok: true,
      tickedAt: new Date().toISOString(),
      ...sequence,
      turnaround,
    });
  } catch (error) {
    console.error("[api/cron/tick] failed", error);
    return NextResponse.json({ error: "tick_failed" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
