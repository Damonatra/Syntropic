/**
 * POST /api/ops/tick — operator entry to the sequence engine (RUN TICK in Ops).
 * Same loop-closer as /api/cron/tick but scoped to console sessions:
 * rate-limited, no ingest key. When ENCLAVE_PASSWORD is set the middleware
 * already gates this behind the enclave session.
 */
import { NextResponse } from "next/server";
import { guardWrite } from "@/lib/vertebra/guard";
import { runSequenceTick } from "@/lib/vertebra/tick";

export async function POST(request: Request) {
  const denied = guardWrite(request, "ops/tick", { key: false, limit: 6, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const outcome = await runSequenceTick();
    return NextResponse.json({ ok: true, tickedAt: new Date().toISOString(), ...outcome });
  } catch (error) {
    console.error("[api/ops/tick] failed", error);
    return NextResponse.json({ error: "tick_failed" }, { status: 500 });
  }
}
