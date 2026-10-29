/**
 * POST /api/portal/ingest — the landing-page bridge. Where client money
 * becomes operator work.
 *
 * Two doors, one ledger:
 *   1. portal_webhook — the executive portal on the landing page signs each
 *      payment POST: HMAC-SHA256(rawBody, PORTAL_INGEST_SECRET), hex, sent as
 *      "x-vertebra-signature". Verified timing-safe; the verbatim payload is
 *      sealed onto the engagement as provenance.
 *   2. manual — the desk's fallback door (source: "manual") for payments that
 *      arrive out-of-band. Operator-initiated from inside the console.
 *
 * Idempotent on `ref` (the payment reference): the landing page can retry on
 * flaky networks and the ledger never double-books a client. Auto-match
 * links the paying client onto the existing prospect book by domain, then by
 * conservative name overlap — strangers stay strangers until the operator
 * links or creates the prospect.
 */
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";
import { matchClient, type MatchCandidate } from "@/lib/vertebra/portal";

const IngestSchema = z.object({
  ref: z.string().min(3).max(120),
  clientName: z.string().min(2).max(160),
  clientDomain: z.string().max(253).optional().nullable(),
  contactName: z.string().max(120).optional().nullable(),
  contactEmail: z.string().email().max(200).optional().nullable(),
  contactPhone: z.string().max(40).optional().nullable(),
  tier: z.enum(["diagnostic_audit", "enterprise_sow"]).default("diagnostic_audit"),
  amountUsd: z.number().int().positive().max(100_000_000),
  paidAt: z.string().datetime().optional(),
  intake: z
    .object({
      rfqPerMonth: z.number().int().min(0).max(100_000).optional(),
      lineItems: z.number().int().min(0).max(10_000).optional(),
    })
    .optional(),
  source: z.enum(["portal_webhook", "manual"]).optional(),
});

function signatureValid(raw: string, provided: string | null): boolean {
  const secret = process.env.PORTAL_INGEST_SECRET;
  if (!secret || !provided) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided.trim().toLowerCase().replace(/^sha256=/, ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const raw = await request.text();

  const sigHeader = request.headers.get("x-vertebra-signature");
  let source: "portal_webhook" | "manual";
  if (sigHeader) {
    if (!signatureValid(raw, sigHeader)) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
    source = "portal_webhook";
  } else {
    // Unsigned requests must explicitly claim the manual door — a bare
    // unsigned webhook-looking payload is refused, never silently trusted.
    let claimed: string | undefined;
    try {
      claimed = (JSON.parse(raw) as { source?: string }).source;
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    if (claimed !== "manual") {
      return NextResponse.json(
        { error: "missing_signature", hint: "sign the raw body with HMAC-SHA256(PORTAL_INGEST_SECRET) in x-vertebra-signature" },
        { status: 401 },
      );
    }
    source = "manual";
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = IngestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  if (body.source && body.source !== source) {
    return NextResponse.json({ error: "source_mismatch", hint: `this request authenticated as ${source}` }, { status: 400 });
  }

  try {
    // ---- idempotency: same payment ref never books twice ------------------ //
    const existing = await db.engagement.findUnique({ where: { ref: body.ref } });
    if (existing) {
      return NextResponse.json({
        duplicate: true,
        engagement: { id: existing.id, ref: existing.ref, status: existing.status, prospectId: existing.prospectId },
      });
    }

    // ---- auto-match onto the book ----------------------------------------- //
    const candidates: MatchCandidate[] = await db.prospect.findMany({
      select: { id: true, name: true, domain: true },
    });
    const match = matchClient(candidates, body.clientName, body.clientDomain ?? null);

    const created = await db.engagement.create({
      data: {
        ref: body.ref,
        clientName: body.clientName,
        clientDomain: body.clientDomain ?? null,
        contactName: body.contactName ?? null,
        contactEmail: body.contactEmail ?? null,
        contactPhone: body.contactPhone ?? null,
        tier: body.tier,
        amountUsd: body.amountUsd,
        source,
        status: "paid",
        ingestPayload: raw,
        intakeRfqPerMonth: body.intake?.rfqPerMonth ?? null,
        intakeLineItems: body.intake?.lineItems ?? null,
        prospectId: match.prospectId,
        paidAt: body.paidAt ? new Date(body.paidAt) : new Date(),
        events: {
          create: {
            kind: "ingested",
            actor: source,
            detail: `${body.tier} · $${body.amountUsd.toLocaleString("en-US")} · ref ${body.ref}`,
          },
        },
      },
    });

    // The match event is a separate write so the ingested event stays atomic
    // with the row itself even if the matcher changes later.
    if (match.prospectId && match.via) {
      const p = candidates.find((c) => c.id === match.prospectId);
      await db.engagementEvent.create({
        data: {
          engagementId: created.id,
          kind: "prospect_linked",
          actor: source,
          detail: `auto-matched ${match.via} → ${p?.name ?? match.prospectId}`,
        },
      });
    }

    invalidateSnapshot();
    return NextResponse.json(
      {
        engagement: {
          id: created.id,
          ref: created.ref,
          status: created.status,
          prospectId: created.prospectId,
          matched: match.prospectId != null,
          matchedVia: match.via,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[api/portal/ingest] failed", error);
    return NextResponse.json({ error: "ingest_failed" }, { status: 500 });
  }
}
