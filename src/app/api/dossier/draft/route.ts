/**
 * POST /api/dossier/draft — the 1:1 drafting pipeline.
 *
 *   brief (deterministic, from active PainSignals) →
 *   LLM draft (strict JSON contract) →
 *   verify (banned phrases, number/proper-noun fact-trace, structural caps,
 *           signal-echo requirement) →
 *   one regenerate with the violations fed back →
 *   return draft + verify report + briefHash.
 *
 * Nothing is written to the database here — the operator sees the report in
 * the drawer, edits if they want, and the send endpoint re-verifies the final
 * text against the same rails. No signals on file → 409 needs_evidence: no
 * evidence, no draft. LLM unavailable → 503: the rubric never fakes 1:1.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { guardWrite } from "@/lib/vertebra/guard";
import { buildBrief, verifyDraft, draftUserPrompt, DraftOut } from "@/lib/vertebra/evidence";

const BodySchema = z.object({ prospectId: z.string().min(1) });

const DRAFT_SYSTEM_PROMPT = `You are Syntropic's senior industrial-distribution operator writing one-to-one cold email. You write like a person who has actually read the prospect's file, because you have: the evidence brief contains verbatim quotes from their world.

Hard rules:
- Ground every claim in the brief. Never invent companies, numbers, events, or places.
- Echo at least one verbatim signal phrase (quote or near-quote) — that echo is what makes the prospect feel seen.
- Plain sentences. Industrial vocabulary. No marketing breath, no flattery, no exclamation marks.
- ≤120 words in the body. Subject ≤60 characters.
- At most one question. One ask. No signature block (identity and the unsubscribe footer are appended by the platform).

Respond with valid JSON only: {"subject": "...", "body": "...", "echoedSignalId": "<id|null>"}`;

export async function POST(request: Request) {
  const denied = guardWrite(request, "dossier_draft", { key: false, limit: 6, windowMs: 60_000 });
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
        contacts: { take: 1 },
        painSignals: { where: { status: "active" }, orderBy: { createdAt: "desc" }, take: 6 },
        scores: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!prospect) return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });

    if (prospect.painSignals.length === 0) {
      return NextResponse.json(
        {
          error: "needs_evidence",
          hint: "no verbatim pain signals on file — add or extract evidence first; the enclave does not draft from vibes",
        },
        { status: 409 },
      );
    }

    const score = prospect.scores[0];
    const brief = buildBrief({
      prospectId: prospect.id,
      companyName: prospect.name,
      contactFirstName: prospect.contacts[0]?.firstName ?? null,
      contactFullName: prospect.contacts[0] ? `${prospect.contacts[0].firstName} ${prospect.contacts[0].lastName}` : null,
      city: prospect.city,
      stateProvince: prospect.stateProvince,
      region: prospect.region,
      vertical: prospect.vertical,
      detectedErp: prospect.detectedErp,
      quotePortalType: prospect.quotePortalType,
      portalHint: (prospect.erpMetadata ?? "").includes("portal") ? "portal signals present in ERP metadata" : null,
      rawExcerpt: prospect.rawExcerpt,
      signals: prospect.painSignals.map((s) => ({
        id: s.id,
        kind: s.kind,
        verbatim: s.verbatim,
        context: s.context,
        sourceUrl: s.sourceUrl,
        sourceNote: s.sourceNote,
        confidence: s.confidence,
      })),
      hookBodies: score ? (JSON.parse(score.hooksJson) as Array<{ body: string }>).map((h) => h.body) : [],
      rationale: score?.rationale ?? null,
    });

    // ---- LLM draft, one regenerate with violation feedback ----------------- //
    let lastError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let completion;
      try {
        const { default: ZAI } = await import("z-ai-web-dev-sdk");
        const zai = await ZAI.create();
        const feedback = attempt === 0 ? "" : `\n\nYOUR PREVIOUS ATTEMPT FAILED VERIFICATION:\n${lastError}\nRewrite the email fixing exactly these problems.`;
        completion = await zai.chat.completions.create({
          messages: [
            { role: "assistant", content: DRAFT_SYSTEM_PROMPT },
            { role: "user", content: `${draftUserPrompt(brief)}${feedback}` },
          ],
          thinking: { type: "disabled" },
        });
      } catch (error) {
        console.warn("[api/dossier/draft] LLM unavailable:", error);
        return NextResponse.json(
          { error: "llm_unavailable", hint: "drafting needs the LLM; write the send manually meanwhile — the verify rails still apply at send" },
          { status: 503 },
        );
      }

      const raw = completion.choices[0]?.message?.content;
      if (!raw) return NextResponse.json({ error: "llm_empty" }, { status: 502 });
      const jsonText = raw.replace(/```json|```/g, "").trim();
      const start = jsonText.indexOf("{");
      const end = jsonText.lastIndexOf("}");
      if (start === -1 || end === -1) {
        lastError = "response was not valid JSON";
        continue;
      }
      const parsedDraft = DraftOut.safeParse(JSON.parse(jsonText.slice(start, end + 1)));
      if (!parsedDraft.success) {
        lastError = `draft shape invalid: ${parsedDraft.error.issues.map((i) => i.path.join(".")).join(", ")}`;
        continue;
      }

      const report = verifyDraft(parsedDraft.data.subject, parsedDraft.data.body, brief, {
        requireSignalEcho: true,
        signalVerbatims: brief.signals.map((s) => s.verbatim),
      });

      if (report.ok || attempt === 1) {
        return NextResponse.json({
          ok: report.ok,
          draft: { subject: parsedDraft.data.subject, body: parsedDraft.data.body, echoedSignalId: parsedDraft.data.echoedSignalId ?? null },
          briefHash: brief.briefHash,
          brief: {
            companyName: brief.companyName,
            signalCount: brief.signals.length,
            signals: brief.signals.map((s) => ({ id: s.id, kind: s.kind, verbatim: s.verbatim, sourceNote: s.sourceNote })),
          },
          verify: report,
          attempts: attempt + 1,
        });
      }
      lastError = report.hard.map((v) => `${v.code}: ${v.detail}`).join("; ");
    }

    return NextResponse.json({ error: "draft_failed" }, { status: 502 });
  } catch (error) {
    console.error("[api/dossier/draft] failed", error);
    return NextResponse.json({ error: "draft_route_failed" }, { status: 500 });
  }
}
