/**
 * /api/dossier/evidence — verbatim pain signals, the raw material for 1:1.
 *
 *   GET    ?prospectId=   list signals (active first, newest first)
 *   POST                  add a signal — operator pastes the quote, never a summary
 *   PATCH                 veto / restore a signal
 *
 * Honesty rules: verbatim text only (kind must be one of the known kinds);
 * extraction from held material lives in /evidence/extract and refuses
 * candidates that are not substrings of that material.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { guardWrite } from "@/lib/vertebra/guard";
import { PAIN_KINDS } from "@/lib/vertebra/evidence";

const SignalSchema = z.object({
  prospectId: z.string().min(1),
  kind: z.enum(PAIN_KINDS),
  verbatim: z.string().trim().min(8).max(600),
  context: z.string().trim().max(300).optional(),
  sourceUrl: z.string().trim().max(500).optional(),
  sourceNote: z.string().trim().max(300).optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
});

const PatchSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["active", "vetoed"]),
});

export async function GET(request: Request) {
  try {
    const prospectId = new URL(request.url).searchParams.get("prospectId");
    if (!prospectId) return NextResponse.json({ error: "missing_prospect_id" }, { status: 400 });
    const signals = await db.painSignal.findMany({
      where: { prospectId },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 30,
    });
    return NextResponse.json({
      signals: signals.map((s) => ({
        id: s.id,
        kind: s.kind,
        verbatim: s.verbatim,
        context: s.context,
        sourceUrl: s.sourceUrl,
        sourceNote: s.sourceNote,
        confidence: s.confidence,
        status: s.status,
        createdAtMs: s.createdAt.getTime(),
      })),
    });
  } catch (error) {
    console.error("[api/dossier/evidence GET] failed", error);
    return NextResponse.json({ error: "evidence_list_failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = guardWrite(request, "dossier_evidence", { key: false, limit: 20, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const parsed = SignalSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
    }
    const { prospectId, kind, verbatim, context, sourceUrl, sourceNote, confidence } = parsed.data;

    const prospect = await db.prospect.findUnique({ where: { id: prospectId }, select: { id: true } });
    if (!prospect) return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });

    // dedupe: same normalized verbatim already active → return it instead
    const existing = await db.painSignal.findMany({
      where: { prospectId, status: "active" },
      select: { id: true, verbatim: true },
    });
    const normalized = verbatim.toLowerCase().replace(/\s+/g, " ").trim();
    const dupe = existing.find((s) => s.verbatim.toLowerCase().replace(/\s+/g, " ").trim() === normalized);
    if (dupe) {
      return NextResponse.json({ ok: true, signal: { id: dupe.id }, deduped: true });
    }

    const created = await db.painSignal.create({
      data: {
        prospectId,
        kind,
        verbatim,
        context: context ?? null,
        sourceUrl: sourceUrl ?? null,
        sourceNote: sourceNote ?? null,
        confidence: confidence ?? "medium",
      },
    });
    return NextResponse.json({ ok: true, signal: { id: created.id }, deduped: false }, { status: 201 });
  } catch (error) {
    console.error("[api/dossier/evidence POST] failed", error);
    return NextResponse.json({ error: "evidence_create_failed" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const denied = guardWrite(request, "dossier_evidence_patch", { key: false, limit: 30, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
    }
    const updated = await db.painSignal.update({
      where: { id: parsed.data.id },
      data: { status: parsed.data.status },
    });
    return NextResponse.json({ ok: true, signal: { id: updated.id, status: updated.status } });
  } catch (error) {
    console.error("[api/dossier/evidence PATCH] failed", error);
    return NextResponse.json({ error: "evidence_patch_failed" }, { status: 500 });
  }
}
