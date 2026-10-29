/**
 * POST /api/ops/tick — operator entry to the loop closers (RUN TICK in Ops).
 * Same closers as /api/cron/tick but scoped to console sessions:
 * rate-limited, no ingest key. Both loops close on one press — Channel A
 * dispatches and the document turnaround engine — and the response carries
 * each loop's ledger additively: sequence fields stay top-level, the
 * turnaround reports under `turnaround`.
 */
import { NextResponse } from "next/server";
import { guardWrite } from "@/lib/vertebra/guard";
import { runSequenceTick, runTurnaroundTick } from "@/lib/vertebra/tick";

export async function POST(request: Request) {
  const denied = guardWrite(request, "ops/tick", { key: false, limit: 6, windowMs: 60_000 });
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
    console.error("[api/ops/tick] failed", error);
    return NextResponse.json({ error: "tick_failed" }, { status: 500 });
  }
}
