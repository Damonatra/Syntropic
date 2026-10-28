import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { scoreProspect } from "@/lib/vertebra/scoring";

const BodySchema = z.object({ prospectId: z.string().min(6) });

export async function POST(request: NextRequest) {
  try {
    const parsed = BodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }

    const prospect = await db.prospect.findUnique({
      where: { id: parsed.data.prospectId },
      include: { contacts: { take: 1 } },
    });
    if (!prospect) {
      return NextResponse.json({ error: "prospect not found" }, { status: 404 });
    }
    if (prospect.ingestion === "filtered") {
      return NextResponse.json(
        { error: `prospect is outside the corridor: ${prospect.filterReason}` },
        { status: 409 },
      );
    }

    const lowered = (prospect.rawExcerpt ?? "").toLowerCase();
    const portalHint =
      ["customer portal", "b2b portal", "ordering portal", "rfq portal", "login to order"].find(
        (hint) => lowered.includes(hint),
      ) ?? null;

    const outcome = await scoreProspect({
      prospectId: prospect.id,
      companyName: prospect.name,
      vertical: prospect.vertical,
      region: prospect.region,
      revenueEstimateUsd: prospect.revenueEstimateUsd,
      employeeCount: prospect.employeeCount,
      detectedErp: prospect.detectedErp,
      portalHint,
      notes: prospect.rawExcerpt,
    });

    const [score] = await db.$transaction([
      db.score.upsert({
        where: { fingerprint: outcome.fingerprint },
        create: {
          prospectId: prospect.id,
          qlvScore: outcome.qlvScore,
          band: outcome.band,
          factorsJson: JSON.stringify(outcome.factors),
          hooksJson: JSON.stringify(outcome.hooks),
          rationale: outcome.rationale,
          model: outcome.model,
          fingerprint: outcome.fingerprint,
        },
        update: { createdAt: new Date() },
      }),
      db.outboxEvent.create({
        data: {
          aggregateType: "score",
          aggregateId: prospect.id,
          eventType: "prospect.scored",
          payload: JSON.stringify({
            company: prospect.name,
            qlvScore: outcome.qlvScore,
            band: outcome.band,
            model: outcome.model,
          }),
        },
      }),
      db.prospect.update({
        where: { id: prospect.id },
        data: { ingestion: "ingested", updatedAt: new Date() },
      }),
    ]);

    return NextResponse.json({
      prospectId: prospect.id,
      qlvScore: outcome.qlvScore,
      band: outcome.band,
      factors: outcome.factors,
      hooks: outcome.hooks,
      rationale: outcome.rationale,
      model: outcome.model,
      scoreId: score.id,
    });
  } catch (error) {
    console.error("[api/score]", error);
    return NextResponse.json({ error: "scoring failed" }, { status: 500 });
  }
}
