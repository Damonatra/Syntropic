/**
 * POST /api/actions — the operator decision loop.
 * Logs called / deferred / snoozed / booked / note against a prospect.
 * Snoozing pushes queued Channel A steps forward by the snooze window.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const ActionSchema = z.object({
  prospectId: z.string().min(1),
  action: z.enum(["called", "deferred", "snoozed", "booked", "note"]),
  note: z.string().max(1000).nullish(),
  hours: z.number().int().min(1).max(336).optional(),
});

export async function POST(request: Request) {
  try {
    const parsed = ActionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
    }
    const { prospectId, action, note, hours } = parsed.data;

    const prospect = await db.prospect.findUnique({ where: { id: prospectId }, select: { id: true, name: true } });
    if (!prospect) return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });

    const resolvedNote =
      action === "snoozed" ? `${note ? `${note} · ` : ""}snooze:${hours ?? 24}h` : (note ?? null);

    const created = await db.operatorAction.create({
      data: { prospectId, action, note: resolvedNote },
    });

    if (action === "snoozed") {
      const until = new Date(Date.now() + (hours ?? 24) * 3_600_000);
      await db.dispatch.updateMany({
        where: { prospectId, channel: "channel_a_automated_email", status: { in: ["queued", "sent", "opened"] } },
        data: { status: "queued", scheduledAt: until },
      });
    }

    return NextResponse.json({
      ok: true,
      action: { id: created.id, action: created.action, createdAt: created.createdAt.toISOString() },
      prospect: { id: prospect.id, name: prospect.name },
    });
  } catch (error) {
    console.error("[api/actions] failed", error);
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
