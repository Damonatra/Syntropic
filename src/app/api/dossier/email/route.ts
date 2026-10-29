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
 *                         an email left the building.
 *
 * Every accepted send writes a Dispatch row (channel operator_manual_email)
 * and an `emailed` OperatorAction so the dossier timeline tells the truth.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { guardWrite } from "@/lib/vertebra/guard";
import { isSuppressed, mailProvider, sendEmail } from "@/lib/vertebra/mailer";

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
      select: { id: true, name: true, country: true, region: true, caslScope: true, bestEmail: true },
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

    // --- M6 rail 4: honest send (sent vs staged) ---------------------------- //
    const result = await sendEmail({
      to: prospect.bestEmail,
      subject,
      text: body,
      prospectId: prospect.id,
      caslScope: prospect.caslScope,
      region: prospect.caslScope ? "ca" : "us",
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
      guard: { caslScope: prospect.caslScope, cooldownOverride: Boolean(override) },
    });
  } catch (error) {
    console.error("[api/dossier/email] failed", error);
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }
}
