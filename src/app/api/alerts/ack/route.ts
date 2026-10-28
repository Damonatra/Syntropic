/**
 * POST /api/alerts/ack — persisted alert acknowledgement.
 * The console acks an alert when the operator has seen it (toast displayed);
 * the aggregator then reports acknowledgedAtMs and reloads never re-fire it.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { guardWrite } from "@/lib/vertebra/guard";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";

const AckSchema = z.object({
  alertIds: z.array(z.string().min(1)).min(1).max(50),
});

export async function POST(request: Request) {
  const denied = guardWrite(request, "alerts/ack", { key: false, limit: 60, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const parsed = AckSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
    }
    const now = new Date();
    const result = await db.intentAlert.updateMany({
      where: { id: { in: parsed.data.alertIds }, acknowledgedAt: null },
      data: { acknowledgedAt: now },
    });
    invalidateSnapshot();
    return NextResponse.json({ ok: true, acknowledged: result.count, at: now.toISOString() });
  } catch (error) {
    console.error("[api/alerts/ack] failed", error);
    return NextResponse.json({ error: "ack_failed" }, { status: 500 });
  }
}
