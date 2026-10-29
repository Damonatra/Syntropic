/**
 * PATCH /api/portal/engagements/[id] — the desk's write path.
 *
 * Ops: stage (guarded adjacent moves), verdict (the $10,000 guarantee
 * decision), link (prospect binding / unbinding), intake (quote volume +
 * contact confirmations), note (free-text ledger entry). Every op appends an
 * EngagementEvent — the trail is append-only, the desk renders it verbatim.
 *
 * The commitment gate: `verdict → delivered` is refused until the guarantee
 * is decided (guaranteeCleared != null) and a confirmed leakage number is on
 * the ledger. The contract the landing page sold gets enforced here.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { guardWrite } from "@/lib/vertebra/guard";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";
import { canTransition, STAGE_LABELS, type EngagementStage } from "@/lib/vertebra/portal";

const PatchSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("stage"), to: z.string().min(2).max(20) }),
  z.object({
    op: z.literal("verdict"),
    confirmedLeakageUsd: z.number().int().min(0).max(1_000_000_000),
    guaranteeCleared: z.boolean(),
    note: z.string().max(2000).optional(),
  }),
  z.object({ op: z.literal("link"), prospectId: z.string().min(1).nullable() }),
  z.object({
    op: z.literal("intake"),
    rfqPerMonth: z.number().int().min(0).max(100_000).optional(),
    lineItems: z.number().int().min(0).max(10_000).optional(),
    contactName: z.string().max(120).optional(),
    contactEmail: z.string().email().max(200).optional(),
    contactPhone: z.string().max(40).optional(),
  }),
  z.object({ op: z.literal("note"), note: z.string().min(1).max(2000) }),
]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = guardWrite(request, "portal/engagements", { key: false, limit: 90, windowMs: 60_000 });
  if (denied) return denied;

  const { id } = await context.params;
  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  try {
    const engagement = await db.engagement.findUnique({ where: { id } });
    if (!engagement) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // ---- stage move -------------------------------------------------------- //
    if (body.op === "stage") {
      if (!canTransition(engagement.status, body.to)) {
        return NextResponse.json(
          { error: "illegal_transition", from: engagement.status, to: body.to },
          { status: 409 },
        );
      }
      // The commitment gate — the audit contract, enforced honestly.
      if (body.to === "delivered") {
        if (engagement.guaranteeCleared == null || engagement.confirmedLeakageUsd == null) {
          return NextResponse.json(
            { error: "verdict_required", hint: "record the guarantee decision before delivering" },
            { status: 409 },
          );
        }
      }
      const updated = await db.engagement.update({
        where: { id },
        data: {
          status: body.to,
          ...(body.to === "delivered" ? { deliveredAt: new Date() } : {}),
        },
      });
      await db.engagementEvent.create({
        data: {
          engagementId: id,
          kind: body.to === "delivered" ? "delivered" : "stage_changed",
          actor: "operator",
          detail: `${STAGE_LABELS[engagement.status as EngagementStage] ?? engagement.status} → ${body.to}`,
        },
      });
      invalidateSnapshot();
      return NextResponse.json({ ok: true, engagement: { id: updated.id, status: updated.status } });
    }

    // ---- verdict — the guarantee decision ---------------------------------- //
    if (body.op === "verdict") {
      const updated = await db.engagement.update({
        where: { id },
        data: {
          confirmedLeakageUsd: body.confirmedLeakageUsd,
          guaranteeCleared: body.guaranteeCleared,
          verdictNote: body.note ?? engagement.verdictNote,
        },
      });
      await db.engagementEvent.create({
        data: {
          engagementId: id,
          kind: "verdict_recorded",
          actor: "operator",
          detail: `confirmed $${body.confirmedLeakageUsd.toLocaleString("en-US")} recoverable · guarantee ${
            body.guaranteeCleared ? "CLEARED" : "NOT CLEARED"
          }${body.note ? ` · ${body.note}` : ""}`,
        },
      });
      invalidateSnapshot();
      return NextResponse.json({
        ok: true,
        engagement: {
          id: updated.id,
          guaranteeCleared: updated.guaranteeCleared,
          confirmedLeakageUsd: updated.confirmedLeakageUsd,
        },
      });
    }

    // ---- prospect link / unbind --------------------------------------------- //
    if (body.op === "link") {
      if (body.prospectId) {
        const prospect = await db.prospect.findUnique({ where: { id: body.prospectId }, select: { id: true, name: true } });
        if (!prospect) return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });
        await db.engagement.update({ where: { id }, data: { prospectId: prospect.id } });
        await db.engagementEvent.create({
          data: { engagementId: id, kind: "prospect_linked", actor: "operator", detail: `linked → ${prospect.name}` },
        });
      } else {
        await db.engagement.update({ where: { id }, data: { prospectId: null } });
        await db.engagementEvent.create({
          data: { engagementId: id, kind: "prospect_linked", actor: "operator", detail: "link cleared" },
        });
      }
      invalidateSnapshot();
      return NextResponse.json({ ok: true });
    }

    // ---- intake confirmations ------------------------------------------------ //
    if (body.op === "intake") {
      const parts: string[] = [];
      if (body.rfqPerMonth != null) parts.push(`${body.rfqPerMonth} RFQ/mo`);
      if (body.lineItems != null) parts.push(`${body.lineItems} lines/RFQ`);
      if (body.contactName != null) parts.push(`contact ${body.contactName}`);
      if (body.contactEmail != null) parts.push(body.contactEmail);
      const updated = await db.engagement.update({
        where: { id },
        data: {
          intakeRfqPerMonth: body.rfqPerMonth ?? engagement.intakeRfqPerMonth,
          intakeLineItems: body.lineItems ?? engagement.intakeLineItems,
          contactName: body.contactName ?? engagement.contactName,
          contactEmail: body.contactEmail ?? engagement.contactEmail,
          contactPhone: body.contactPhone ?? engagement.contactPhone,
        },
      });
      await db.engagementEvent.create({
        data: { engagementId: id, kind: "note", actor: "operator", detail: `intake confirmed · ${parts.join(" · ") || "no changes"}` },
      });
      invalidateSnapshot();
      return NextResponse.json({ ok: true, engagement: { id: updated.id } });
    }

    // ---- note ------------------------------------------------------------------ //
    await db.engagementEvent.create({
      data: { engagementId: id, kind: "note", actor: "operator", detail: body.note },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[api/portal/engagements] failed", error);
    return NextResponse.json({ error: "patch_failed" }, { status: 500 });
  }
}
