/**
 * POST /api/high-touch/export — operator entry for the Channel B handoff.
 *
 * The Josias high-touch queue used to be exportable only engine-side
 * (exportedAt written by the batch worker). This route gives the console a
 * one-verb export: marks the queue item exported, publishes the outbox event
 * documenting the handoff, and logs the operator action — all honest rows,
 * no simulated delivery.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { guardWrite } from "@/lib/vertebra/guard";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";

const ExportSchema = z.object({
  prospectId: z.string().min(1),
});

export async function POST(request: Request) {
  const denied = guardWrite(request, "high-touch/export", { key: false, limit: 20, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const parsed = ExportSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
    }
    const { prospectId } = parsed.data;

    const item = await db.highTouchQueueItem.findUnique({
      where: { prospectId },
      include: { prospect: { select: { id: true, name: true, bestEmail: true } } },
    });
    if (!item) return NextResponse.json({ error: "not_in_queue" }, { status: 404 });

    if (item.exportedAt) {
      return NextResponse.json({
        ok: true,
        alreadyExported: true,
        exportedAtMs: item.exportedAt.getTime(),
        prospect: item.prospect,
      });
    }

    const now = new Date();
    const updated = await db.highTouchQueueItem.update({
      where: { id: item.id },
      data: { exportedAt: now },
    });

    await db.outboxEvent.create({
      data: {
        aggregateType: "high_touch_queue_item",
        aggregateId: item.id,
        eventType: "high_touch.exported",
        payload: JSON.stringify({
          prospectId: item.prospectId,
          prospectName: item.prospect.name,
          qlvScore: item.qlvScore,
          qlvBand: item.qlvBand,
          topHook: item.topHook,
          exportedFrom: "command_centre",
        }),
        publishedAt: now,
      },
    });

    await db.operatorAction.create({
      data: {
        prospectId,
        action: "note",
        note: `Channel B export — ${item.prospect.name} handed to Josias queue (QLV ${item.qlvScore}, ${item.qlvBand})`,
      },
    });

    invalidateSnapshot();
    return NextResponse.json({
      ok: true,
      alreadyExported: false,
      exportedAtMs: updated.exportedAt?.getTime() ?? now.getTime(),
      prospect: item.prospect,
    });
  } catch (error) {
    console.error("[api/high-touch/export] failed", error);
    return NextResponse.json({ error: "export_failed" }, { status: 500 });
  }
}
