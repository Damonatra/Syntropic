/**
 * POST /api/dossier/evidence/extract — the honest research pass.
 *
 * The LLM's job here is EXTRACTION, not invention: it reads only material the
 * enclave already holds (ingest excerpt, portal hints, inbound replies, audit
 * findings, operator notes) and proposes verbatim pain quotes. Every candidate
 * is then checked deterministically: a verbatim that is not a substring of the
 * material it claims to come from is DISCARDED and counted. Nothing invented
 * ever reaches the ledger. With no material on file the route says so instead
 * of pretending.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { guardWrite } from "@/lib/vertebra/guard";
import { PAIN_KINDS } from "@/lib/vertebra/evidence";

const BodySchema = z.object({ prospectId: z.string().min(1) });

const Candidate = z.object({
  kind: z.enum(PAIN_KINDS),
  verbatim: z.string().min(8).max(400),
  context: z.string().max(300).optional(),
  sourceKey: z.string().max(80), // which material section the quote came from
  confidence: z.enum(["high", "medium", "low"]),
});
const ExtractOut = z.object({ candidates: z.array(Candidate).max(8) });

const SYSTEM_PROMPT = `You extract verbatim pain evidence for B2B cold outreach (industrial distributors: RFQ latency, legacy quoting portals, unapplied vendor SPAs, margin leakage).

You will receive numbered material sections, each tagged like [S1] source=... — quotes you propose MUST be copied EXACTLY (word for word) from one section's text. Never paraphrase, never invent, never complete a thought the source only implies. If the material contains no usable pain language, return an empty list — that is a valid, honest answer.

Pick quotes that reveal frustration, cost, delay, or manual toil in the prospect's quoting/RFQ operation — the words themselves are the payload because they will be echoed back to the prospect.

Respond with valid JSON only: {"candidates": [{"kind": "review_complaint|site_copy|job_posting|reply_language|telemetry|audit_finding|operator_note|research", "verbatim": "<exact substring>", "context": "<one line>", "sourceKey": "S1", "confidence": "high|medium|low"}]}`;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019"]/g, "'").replace(/\s+/g, " ").trim();
}

export async function POST(request: Request) {
  const denied = guardWrite(request, "dossier_evidence_extract", { key: false, limit: 4, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const parsed = BodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
    }
    const { prospectId } = parsed.data;

    const prospect = await db.prospect.findUnique({
      where: { id: prospectId },
      include: {
        inboundReplies: { orderBy: { receivedAt: "desc" }, take: 3 },
        scores: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!prospect) return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });
    // AuditDocument carries a plain prospectId column (no relation) — query it directly.
    const latestAudit = await db.auditDocument.findFirst({
      where: { prospectId },
      orderBy: { createdAt: "desc" },
    });

    // ---- assemble held material, each block with a section key ------------- //
    const sections: Array<{ key: string; source: string; text: string }> = [];
    if (prospect.rawExcerpt?.trim()) {
      sections.push({ key: "S1", source: "ingest excerpt (their listing/profile)", text: prospect.rawExcerpt });
    }
    if (prospect.erpMetadata?.trim()) {
      sections.push({ key: "S2", source: "ERP metadata", text: prospect.erpMetadata.slice(0, 1500) });
    }
    prospect.inboundReplies.forEach((r, i) => {
      sections.push({ key: `R${i + 1}`, source: `their reply (${r.fromEmail}, ${r.receivedAt.toISOString().slice(0, 10)})`, text: r.body });
    });
    if (latestAudit?.findingsJson) {
      sections.push({ key: "A1", source: `audit document (${latestAudit.fileName})`, text: latestAudit.findingsJson.slice(0, 1500) });
    }

    if (sections.length === 0) {
      return NextResponse.json(
        {
          error: "no_material",
          hint: "nothing held to extract from — add the quote by hand or ingest the prospect first; the enclave does not fabricate evidence",
        },
        { status: 409 },
      );
    }

    const material = sections
      .map((s) => `[${s.key}] source=${s.source}\n${s.text}`)
      .join("\n\n");

    // ---- LLM extraction ---------------------------------------------------- //
    let candidates: z.infer<typeof Candidate>[] = [];
    try {
      const { default: ZAI } = await import("z-ai-web-dev-sdk");
      const zai = await ZAI.create();
      const completion = await zai.chat.completions.create({
        messages: [
          { role: "assistant", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Extract verbatim pain quotes for ${prospect.name}.\n\nMATERIAL:\n${material}`,
          },
        ],
        thinking: { type: "disabled" },
      });
      const raw = completion.choices[0]?.message?.content;
      if (raw) {
        const jsonText = raw.replace(/```json|```/g, "").trim();
        const start = jsonText.indexOf("{");
        const end = jsonText.lastIndexOf("}");
        if (start !== -1 && end !== -1) {
          const parsedOut = ExtractOut.safeParse(JSON.parse(jsonText.slice(start, end + 1)));
          if (parsedOut.success) candidates = parsedOut.data.candidates;
        }
      }
    } catch (error) {
      console.warn("[evidence/extract] LLM unavailable:", error);
      return NextResponse.json(
        { error: "llm_unavailable", hint: "extraction needs the LLM; add signals by hand meanwhile" },
        { status: 503 },
      );
    }

    // ---- deterministic honesty check: substring of the cited section ------- //
    const existing = await db.painSignal.findMany({
      where: { prospectId },
      select: { verbatim: true, status: true },
    });
    const existingNorm = new Set(existing.map((s) => normalize(s.verbatim)));

    const stored: Array<{ id: string; kind: string; verbatim: string }> = [];
    const discarded: Array<{ verbatim: string; reason: string }> = [];

    for (const c of candidates) {
      const section = sections.find((s) => s.key === c.sourceKey) ?? sections.find((s) => normalize(c.verbatim).includes(normalize(s.text).slice(0, 40)));
      const haystack = section ? normalize(section.text) : sections.map((s) => normalize(s.text)).join(" ");
      const verbatimNorm = normalize(c.verbatim);
      if (!haystack.includes(verbatimNorm)) {
        discarded.push({ verbatim: c.verbatim.slice(0, 120), reason: "not a verbatim substring of held material" });
        continue;
      }
      if (existingNorm.has(verbatimNorm)) {
        discarded.push({ verbatim: c.verbatim.slice(0, 120), reason: "already on file" });
        continue;
      }
      const created = await db.painSignal.create({
        data: {
          prospectId,
          kind: c.kind,
          verbatim: c.verbatim,
          context: c.context ?? null,
          sourceNote: section ? `${section.source}` : "held material",
          confidence: c.confidence,
        },
      });
      existingNorm.add(verbatimNorm);
      stored.push({ id: created.id, kind: c.kind, verbatim: c.verbatim });
      if (stored.length >= 5) break;
    }

    return NextResponse.json({
      ok: true,
      stored,
      discarded,
      materialSections: sections.map((s) => ({ key: s.key, source: s.source, chars: s.text.length })),
    });
  } catch (error) {
    console.error("[api/dossier/evidence/extract] failed", error);
    return NextResponse.json({ error: "extract_failed" }, { status: 500 });
  }
}
