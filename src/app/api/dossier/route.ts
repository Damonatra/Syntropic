/**
 * GET /api/dossier?id=… — full operator dossier for one lead:
 * telemetry timeline, dispatch history, operator actions, reply threads.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });

    const prospect = await db.prospect.findUnique({
      where: { id },
      include: {
        contacts: true,
        scores: { orderBy: { createdAt: "desc" }, take: 1 },
        cluster: true,
        highTouch: true,
        dispatches: { orderBy: { createdAt: "desc" }, take: 8 },
        operatorActions: { orderBy: { createdAt: "desc" }, take: 6 },
      },
    });
    if (!prospect) return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });

    const telemetry = await db.telemetryEvent.findMany({
      where: { prospectId: id },
      orderBy: { occurredAt: "desc" },
      take: 15,
    });

    const replies = await db.inboundReply.findMany({
      where: { prospectId: id },
      orderBy: { receivedAt: "desc" },
      take: 4,
      include: { drafts: { orderBy: { createdAt: "desc" }, take: 1 } },
    });

    return NextResponse.json({
      prospect: {
        id: prospect.id,
        name: prospect.name,
        domain: prospect.domain,
        website: prospect.website,
        vertical: prospect.vertical,
        region: prospect.region,
        city: prospect.city,
        stateProvince: prospect.stateProvince,
        country: prospect.country,
        revenueEstimateUsd: prospect.revenueEstimateUsd,
        employeeCount: prospect.employeeCount,
        ingestion: prospect.ingestion,
        caslScope: prospect.caslScope,
        bestEmail: prospect.bestEmail,
        emailPattern: prospect.emailPattern,
        detectedErp: prospect.detectedErp,
        quotePortalType: prospect.quotePortalType,
        erpMetadata: prospect.erpMetadata,
        auditImageUrl: prospect.auditImageUrl,
        latitude: prospect.latitude,
        longitude: prospect.longitude,
        lastIntentHeat: prospect.lastIntentHeat,
        clusterName: prospect.cluster?.clusterName ?? null,
        score: prospect.scores[0]
          ? {
              qlvScore: prospect.scores[0].qlvScore,
              band: prospect.scores[0].band,
              factors: JSON.parse(prospect.scores[0].factorsJson),
              hooks: JSON.parse(prospect.scores[0].hooksJson),
              rationale: prospect.scores[0].rationale,
              model: prospect.scores[0].model,
            }
          : null,
        contacts: prospect.contacts.map((c) => ({
          name: `${c.firstName} ${c.lastName}`,
          role: c.role,
          titleRaw: c.titleRaw,
          phone: c.phone,
        })),
        highTouch: prospect.highTouch
          ? { qlvScore: prospect.highTouch.qlvScore, exported: Boolean(prospect.highTouch.exportedAt) }
          : null,
      },
      telemetry: telemetry.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        url: e.url,
        city: e.city,
        country: e.country,
        device: e.device,
        durationMs: e.durationMs,
        occurredAtMs: e.occurredAt.getTime(),
      })),
      dispatches: prospect.dispatches.map((d) => ({
        id: d.id,
        channel: d.channel,
        status: d.status,
        subject: d.subject,
        provider: d.provider,
        scheduledAtMs: d.scheduledAt?.getTime() ?? null,
        createdAtMs: d.createdAt.getTime(),
      })),
      actions: prospect.operatorActions.map((a) => ({
        id: a.id,
        action: a.action,
        note: a.note,
        createdAtMs: a.createdAt.getTime(),
      })),
      replies: replies.map((r) => ({
        id: r.id,
        intent: r.intent,
        fromEmail: r.fromEmail,
        subject: r.subject,
        body: r.body,
        receivedAtMs: r.receivedAt.getTime(),
        draft: r.drafts[0]
          ? { id: r.drafts[0].id, status: r.drafts[0].status, subject: r.drafts[0].subject, body: r.drafts[0].body }
          : null,
      })),
    });
  } catch (error) {
    console.error("[api/dossier] failed", error);
    return NextResponse.json({ error: "dossier_failed" }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
