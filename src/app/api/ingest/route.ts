import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  classifyVertical,
  corridorCheck,
  detectRegion,
  evaluateCaslScope,
  registrableDomain,
  type Vertical,
} from "@/lib/vertebra/classify";

const MANUAL_SOURCE = "console";

const ProspectSchema = z.object({
  name: z.string().min(2).max(200),
  domain: z.string().min(3).max(200),
  vertical: z.enum(["pvf", "electrical", "hvac", "fluid_power"]).optional(),
  region: z.enum(["us", "ca"]).optional(),
  city: z.string().max(120).optional().nullable(),
  stateProvince: z.string().max(120).optional().nullable(),
  country: z.string().max(120).optional().nullable(),
  postalCode: z.string().max(20).optional().nullable(),
  employeeCount: z.number().int().positive().optional().nullable(),
  revenueEstimateUsd: z.number().int().nonnegative().optional().nullable(),
  detectedErp: z.string().max(120).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  contactFirstName: z.string().max(80).optional().nullable(),
  contactLastName: z.string().max(80).optional().nullable(),
  contactRole: z.string().max(60).optional().nullable(),
});

const BodySchema = z.object({
  prospect: ProspectSchema,
});

function normaliseName(name: string): string {
  let cleaned = name.replace(/\s+/g, " ").trim();
  for (const drop of [" inc.", " inc", " llc", " ltd.", " ltd", " corp.", " corp", " co.", " co", " company"]) {
    if (cleaned.toLowerCase().endsWith(drop)) {
      cleaned = cleaned.slice(0, -drop.length).replace(/[\s,.]+$/, "");
    }
  }
  return cleaned;
}

export async function POST(request: NextRequest) {
  try {
    const json = await request.json();
    const body = BodySchema.safeParse(json);
    if (!body.success) {
      return NextResponse.json(
        { error: "invalid payload", details: body.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const input = body.data.prospect;
    const domain = registrableDomain(input.domain);
    if (!domain) {
      return NextResponse.json({ error: "invalid domain" }, { status: 400 });
    }

    // Vertical: explicit wins, else classify from name + notes.
    const vertical: Vertical | null =
      (input.vertical as Vertical | undefined) ??
      classifyVertical(input.name, input.detectedErp, input.notes);
    const region =
      input.region ??
      detectRegion({
        stateProvince: input.stateProvince,
        country: input.country,
        postalCode: input.postalCode,
        domain,
      });

    const corridor = corridorCheck({
      vertical,
      revenueEstimateUsd: input.revenueEstimateUsd ?? null,
      employeeCount: input.employeeCount ?? null,
    });
    const casl = evaluateCaslScope({
      domain,
      region,
      stateProvince: input.stateProvince,
      country: input.country,
    });

    const ingestion = corridor.accepted ? "ingested" : "filtered";
    const domainKey = domain || normaliseName(input.name).toLowerCase();

    const prospect = await db.prospect.upsert({
      where: { source_domainKey: { source: MANUAL_SOURCE, domainKey } },
      create: {
        source: MANUAL_SOURCE,
        sourceUrl: "console://manual-entry",
        name: input.name.trim(),
        domainKey,
        domain,
        website: domain ? `https://${domain}` : null,
        vertical,
        region,
        city: input.city ?? null,
        stateProvince: input.stateProvince ?? null,
        country:
          input.country ??
          (region === "ca" ? "Canada" : region === "us" ? "United States" : null),
        postalCode: input.postalCode ?? null,
        employeeCount: input.employeeCount ?? null,
        revenueEstimateUsd: input.revenueEstimateUsd ?? null,
        revenueConfidence: input.revenueEstimateUsd ? "estimated" : "unknown",
        detectedErp: input.detectedErp ?? null,
        rawExcerpt: input.notes ?? null,
        ingestion,
        filterReason: corridor.reason,
        caslScope: casl.scope,
        caslReason: casl.reason,
        contacts: {
          create:
            input.contactFirstName && input.contactLastName
              ? [
                  {
                    firstName: input.contactFirstName.trim(),
                    lastName: input.contactLastName.trim(),
                    role: input.contactRole ?? "unknown",
                  },
                ]
              : [],
        },
      },
      update: {
        name: input.name.trim(),
        vertical,
        region,
        employeeCount: input.employeeCount ?? null,
        revenueEstimateUsd: input.revenueEstimateUsd ?? null,
        detectedErp: input.detectedErp ?? null,
        rawExcerpt: input.notes ?? null,
        ingestion,
        filterReason: corridor.reason,
        caslScope: casl.scope,
        caslReason: casl.reason,
        updatedAt: new Date(),
      },
    });

    await db.outboxEvent.create({
      data: {
        aggregateType: "prospect",
        aggregateId: prospect.id,
        eventType: corridor.accepted ? "prospect.ingested" : "prospect.filtered",
        payload: JSON.stringify({
          company: prospect.name,
          domain,
          vertical,
          region,
          revenueEstimateUsd: prospect.revenueEstimateUsd,
          filterReason: corridor.reason,
        }),
      },
    });

    if (!corridor.accepted) {
      return NextResponse.json(
        {
          prospectId: prospect.id,
          status: "filtered",
          reason: corridor.reason,
          message: `${prospect.name} sits outside the $10M-$150M / target-vertical corridor: ${corridor.reason}`,
        },
        { status: 202 },
      );
    }

    return NextResponse.json({
      prospectId: prospect.id,
      status: "ingested",
      vertical,
      region,
      caslScope: casl.scope,
    });
  } catch (error) {
    console.error("[api/ingest]", error);
    return NextResponse.json({ error: "ingestion failed" }, { status: 500 });
  }
}
