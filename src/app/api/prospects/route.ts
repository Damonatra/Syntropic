import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { Hook, QLVFactor } from "@/lib/vertebra/scoring";

export async function GET() {
  try {
    const prospects = await db.prospect.findMany({
      orderBy: [{ updatedAt: "desc" }],
      take: 100,
      include: {
        contacts: { take: 1 },
        scores: { orderBy: { createdAt: "desc" }, take: 1 },
        dispatches: { orderBy: { createdAt: "desc" }, take: 1 },
        highTouch: true,
      },
    });

    return NextResponse.json({
      prospects: prospects.map((p) => {
        const score = p.scores[0];
        return {
          id: p.id,
          name: p.name,
          domain: p.domain,
          vertical: p.vertical,
          region: p.region,
          city: p.city,
          stateProvince: p.stateProvince,
          revenueEstimateUsd: p.revenueEstimateUsd,
          revenueConfidence: p.revenueConfidence,
          employeeCount: p.employeeCount,
          detectedErp: p.detectedErp,
          ingestion: p.ingestion,
          filterReason: p.filterReason,
          caslScope: p.caslScope,
          caslReason: p.caslReason,
          bestEmail: p.bestEmail,
          contact: p.contacts[0]
            ? {
                firstName: p.contacts[0].firstName,
                lastName: p.contacts[0].lastName,
                role: p.contacts[0].role,
              }
            : null,
          score: score
            ? {
                qlvScore: score.qlvScore,
                band: score.band,
                factors: JSON.parse(score.factorsJson) as QLVFactor[],
                hooks: JSON.parse(score.hooksJson) as Hook[],
                rationale: score.rationale,
                model: score.model,
                createdAt: score.createdAt.toISOString(),
              }
            : null,
          dispatch: p.dispatches[0]
            ? {
                channel: p.dispatches[0].channel,
                status: p.dispatches[0].status,
                subject: p.dispatches[0].subject,
                fromDomain: p.dispatches[0].fromDomain,
                provider: p.dispatches[0].provider,
                createdAt: p.dispatches[0].createdAt.toISOString(),
              }
            : null,
          highTouchExported: p.highTouch?.exportedAt ? p.highTouch.exportedAt.toISOString() : null,
          calendarEventId: p.highTouch?.calendarEventId ?? null,
          updatedAt: p.updatedAt.toISOString(),
        };
      }),
    });
  } catch (error) {
    console.error("[api/prospects]", error);
    return NextResponse.json({ error: "failed to list prospects" }, { status: 500 });
  }
}
