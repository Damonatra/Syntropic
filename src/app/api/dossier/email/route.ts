/**
 * POST /api/dossier/email — the operator desk's cold-email send.
 *
 * Part of the dossier "handle everything here" surface (M3/M4). Ships with
 * its safety rails (M6) — the endpoint never exists without them:
 *
 *   1. CASL hard gate   — a Canadian prospect without an established consent
 *                         basis (caslScope=false) is refused server-side.
 *                         US prospects ride CAN-SPAM; the CASL footer is
 *                         applied to every send regardless.
 *   2. Suppression      — isSuppressed() check; a suppressed address is
 *                         never emailed, no exceptions, no override.
 *   3. 24h cooldown     — one manual cold email per prospect per day;
 *                         `override: true` forces past it (the UI surfaces
 *                         the previous send when it does).
 *   4. Honest send state — resend when RESEND_API_KEY is configured, else
 *                         status "staged": logged, visible, never pretending
 *                         an email left the building. Live egress additionally
 *                         requires SYNTROPIC_UNSUBSCRIBE_SECRET + a locked
 *                         enclave (mailer preflight interlocks).
 *   5. Integrity wall   — the final text is fact-traced against the evidence
 *                         brief (banned phrases, numbers/proper nouns grounded
 *                         in held material, structural caps). Hard violations
 *                         refuse the send with 422; there is no override —
 *                         edit the text instead. Fabricated "personalization"
 *                         is worse than none.
 *
 * Every accepted send writes a Dispatch row (channel operator_manual_email)
 * with briefHash + verifyReportJson, and an `emailed` OperatorAction so the
 * dossier timeline tells the truth.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { guardWrite } from "@/lib/vertebra/guard";
import { isSuppressed, mailProvider, sendEmail } from "@/lib/vertebra/mailer";
import { buildBrief, verifyDraft, CLOSE_CTA } from "@/lib/vertebra/evidence";

const EmailSchema = z.object({
  prospectId: z.string().min(1),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  /** Force past the 24h cooldown. Never bypasses suppression or the CASL gate. */
  override: z.boolean().optional(),
});

const COOLDOWN_MS = 24 * 3_600_000;

export async function POST(request: Request) {
  const denied = guardWrite(request, "dossier_email", { key: false, limit: 12, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const parsed = EmailSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
    }
    const { prospectId, subject, body, override } = parsed.data;

    const prospect = await db.prospect.findUnique({
      where: { id: prospectId },
      select: {
        id: true,
        name: true,
        country: true,
        region: true,
        caslScope: true,
        caslReason: true,
        bestEmail: true,
        city: true,
        stateProvince: true,
        vertical: true,
        detectedErp: true,
        quotePortalType: true,
        rawExcerpt: true,
        contacts: { take: 1, select: { firstName: true, lastName: true } },
        painSignals: { where: { status: "active" }, orderBy: { createdAt: "desc" }, take: 6 },
        scores: { orderBy: { createdAt: "desc" }, take: 1, select: { hooksJson: true, rationale: true } },
      },
    });
    if (!prospect) return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });
    if (!prospect.bestEmail) {
      return NextResponse.json({ error: "no_email", hint: "no verified address on file — resolve a contact first" }, { status: 400 });
    }

    // --- M6 rail 1: CASL hard gate (Canadian, no consent basis) ------------- //
    const isCanadian = prospect.country?.toLowerCase().includes("canada") || prospect.region === "ca";
    if (isCanadian && !prospect.caslScope) {
      return NextResponse.json(
        {
          error: "casl_consent_required",
          reason: prospect.caslReason ?? "no_consent_scope",
          hint: "Canadian prospect without an established consent basis — cold send refused by the enclave, not the operator.",
        },
        { status: 403 },
      );
    }

    // --- M6 rail 2: suppression (absolute) ---------------------------------- //
    if (await isSuppressed(prospect.bestEmail, prospect.id)) {
      return NextResponse.json(
        { error: "suppressed", hint: "this address opted out — the enclave will not send" },
        { status: 403 },
      );
    }

    // --- M6 rail 3: 24h manual-send cooldown (overridable) ------------------ //
    const recent = await db.dispatch.findFirst({
      where: {
        prospectId,
        channel: "operator_manual_email",
        status: { not: "failed" },
        createdAt: { gte: new Date(Date.now() - COOLDOWN_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, subject: true, createdAt: true },
    });
    if (recent && !override) {
      return NextResponse.json(
        {
          error: "cooldown_active",
          lastSend: { id: recent.id, status: recent.status, subject: recent.subject, atMs: recent.createdAt.getTime() },
          hint: "a manual cold email went out inside 24h — resend with override if you are sure",
        },
        { status: 409 },
      );
    }

    // --- M6 rail 5 / integrity wall: fact-trace the final text -------------- //
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
      portalHint: null,
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
      // The standard CTA is sender boilerplate, not a prospect claim — the
      // "3-slide teardown" must never trip the number fact-trace.
      boilerplate: [CLOSE_CTA],
    });
    const verify = verifyDraft(subject, body, brief, { requireSignalEcho: false });
    if (!verify.ok) {
      return NextResponse.json(
        {
          error: "verify_failed",
          violations: verify.hard,
          hint: "the integrity wall refused this send — every number and proper noun must be grounded in the evidence on file; edit the text, there is no override",
        },
        { status: 422 },
      );
    }

    // --- M6 rail 4: honest send (sent vs staged) ---------------------------- //
    const result = await sendEmail({
      to: prospect.bestEmail,
      subject,
      text: body,
      prospectId: prospect.id,
      caslScope: prospect.caslScope,
      region: prospect.region,
    });

    const dispatch = await db.dispatch.create({
      data: {
        prospectId: prospect.id,
        channel: "operator_manual_email",
        status: result.status, // sent | staged | failed
        caslScope: prospect.caslScope,
        subject,
        body,
        fromDomain: process.env.VERTEBRA_SEND_DOMAIN ?? null,
        provider: mailProvider(),
        providerMsgId: result.providerMsgId ?? null,
        footerApplied: result.footerApplied,
        briefHash: brief.signals.length > 0 ? brief.briefHash : null,
        verifyReportJson: JSON.stringify({ ok: verify.ok, hard: verify.hard, soft: verify.soft, stats: verify.stats }),
        error: result.reason ?? null,
      },
    });

    await db.operatorAction.create({
      data: { prospectId: prospect.id, action: "emailed", note: `${result.status} · ${subject}` },
    });

    return NextResponse.json({
      ok: result.status !== "failed",
      send: { status: result.status, reason: result.reason ?? null, providerMsgId: result.providerMsgId ?? null, provider: mailProvider() },
      dispatch: { id: dispatch.id, channel: "operator_manual_email", status: dispatch.status },
      prospect: { id: prospect.id, name: prospect.name, email: prospect.bestEmail },
      evidence: { signalCount: brief.signals.length, briefHash: brief.signals.length > 0 ? brief.briefHash : null },
      verify: { ok: verify.ok, soft: verify.soft },
      guard: { caslScope: prospect.caslScope, cooldownOverride: Boolean(override) },
    });
  } catch (error) {
    console.error("[api/dossier/email] failed", error);
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }
}
