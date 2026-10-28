import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { buildCaslFooter, buildEmailHeaders, CLOSE_CTA, subjectForHook } from "@/lib/vertebra/casl";
import { generateCandidates } from "@/lib/vertebra/permutations";
import { CHANNEL_A_MIN_SCORE } from "@/lib/vertebra/scoring";

const BodySchema = z.object({ prospectId: z.string().min(6) });

const SENDING_DOMAINS = (process.env.VERTEBRA_SENDING_DOMAINS ?? "syntropic-os.com")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export async function POST(request: NextRequest) {
  try {
    const parsed = BodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }

    const prospect = await db.prospect.findUnique({
      where: { id: parsed.data.prospectId },
      include: {
        contacts: { take: 1 },
        scores: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!prospect) return NextResponse.json({ error: "prospect not found" }, { status: 404 });

    const score = prospect.scores[0];
    if (!score) {
      return NextResponse.json(
        { error: "prospect must be scored before dispatch" },
        { status: 409 },
      );
    }
    const existingDispatch = await db.dispatch.findFirst({
      where: { prospectId: prospect.id, status: { in: ["queued", "sent"] } },
    });
    if (existingDispatch) {
      return NextResponse.json(
        { error: "prospect already dispatched", dispatchId: existingDispatch.id, status: existingDispatch.status },
        { status: 409 },
      );
    }

    const hooks = JSON.parse(score.hooksJson) as Array<{ flavor: string; body: string }>;
    const topHook = hooks[0];
    const channel =
      score.qlvScore >= CHANNEL_A_MIN_SCORE
        ? "channel_a_automated_email"
        : "channel_b_josias_high_touch";

    const reasons = [
      score.qlvScore >= CHANNEL_A_MIN_SCORE
        ? `QLV ${score.qlvScore} >= channel_a_min_score ${CHANNEL_A_MIN_SCORE}: automation wins at this score`
        : `QLV ${score.qlvScore} < channel_a_min_score ${CHANNEL_A_MIN_SCORE}: high-touch craft converts better here`,
    ];
    if (prospect.caslScope) {
      reasons.push("CASL scope detected: compliance footer + one-click unsubscribe enforced");
    }

    // ---------------------------------------------------------------- Channel A
    if (channel === "channel_a_automated_email") {
      let bestEmail = prospect.bestEmail;
      if (!bestEmail && prospect.domain && prospect.contacts[0]) {
        const candidates = generateCandidates(
          prospect.contacts[0].firstName,
          prospect.contacts[0].lastName,
          prospect.domain,
          3,
        );
        bestEmail = candidates[0]?.address ?? null;
        if (bestEmail) {
          await db.prospect.update({
            where: { id: prospect.id },
            data: { bestEmail, emailPattern: candidates[0].pattern },
          });
          reasons.push(`mailbox inferred via ${candidates[0].pattern} permutation (SMTP verification runs in the engine)`);
        }
      }
      if (!bestEmail) {
        reasons.push("suppressed: no verified mailbox available");
        return NextResponse.json({ channel, status: "suppressed", reasons }, { status: 200 });
      }

      const subject = subjectForHook(topHook?.flavor ?? "", prospect.name);
      const body = `${topHook?.body ?? ""}\n\n${CLOSE_CTA}`;
      const footer = buildCaslFooter(prospect.id, bestEmail, prospect.region);
      const headers = buildEmailHeaders(prospect.id, bestEmail, prospect.caslScope);
      const fromDomain = SENDING_DOMAINS[0];
      const fromEmail = `growth@${fromDomain}`;

      const bodyWithFooter = `${body}\n\n--\n${footer}`;
      let status = "queued";
      let provider = "resend";
      let providerMsgId: string | null = null;
      let error: string | null = null;

      const resendKey = process.env.RESEND_API_KEY;
      if (resendKey) {
        try {
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${resendKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: `Syntropic Industrial Growth <${fromEmail}>`,
              to: [bestEmail],
              subject,
              text: bodyWithFooter,
              headers: { ...headers, "X-Entity-Ref-ID": prospect.id },
            }),
          });
          if (!response.ok) {
            throw new Error(`resend rejected send (${response.status}): ${(await response.text()).slice(0, 300)}`);
          }
          const data = (await response.json()) as { id?: string };
          status = "sent";
          providerMsgId = data.id ?? null;
        } catch (exc) {
          status = "failed";
          error = exc instanceof Error ? exc.message : String(exc);
        }
      } else {
        provider = "resend-unconfigured";
        reasons.push("RESEND_API_KEY not set: queued for the engine's Channel A worker (pacing + rotation enforced there)");
      }

      const dispatch = await db.$transaction(async (tx) => {
        const created = await tx.dispatch.create({
          data: {
            prospectId: prospect.id,
            channel,
            status,
            caslScope: prospect.caslScope,
            subject,
            body: bodyWithFooter,
            fromDomain,
            provider,
            providerMsgId,
            footerApplied: footer,
            error,
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateType: "dispatch",
            aggregateId: created.id,
            eventType: status === "sent" ? "dispatch.email.sent" : "dispatch.email.queued",
            payload: JSON.stringify({
              company: prospect.name,
              fromDomain,
              caslScope: prospect.caslScope,
              qlvScore: score.qlvScore,
            }),
          },
        });
        return created;
      });

      return NextResponse.json({
        dispatchId: dispatch.id,
        channel,
        status,
        reasons,
        subject,
        fromDomain,
        caslScope: prospect.caslScope,
        error,
      });
    }

    // ---------------------------------------------------------------- Channel B
    const contact = prospect.contacts[0];
    const dispatch = await db.$transaction(async (tx) => {
      const created = await tx.dispatch.create({
        data: {
          prospectId: prospect.id,
          channel,
          status: "queued",
          caslScope: prospect.caslScope,
        },
      });
      await tx.highTouchQueueItem.create({
        data: {
          prospectId: prospect.id,
          qlvScore: score.qlvScore,
          qlvBand: score.band,
          topHook: topHook?.body ?? "",
          rationale: score.rationale,
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateType: "high_touch",
          aggregateId: created.id,
          eventType: "dispatch.high_touch.queued",
          payload: JSON.stringify({
            company: prospect.name,
            qlvScore: score.qlvScore,
            caslScope: prospect.caslScope,
          }),
        },
      });
      return created;
    });

    return NextResponse.json({
      dispatchId: dispatch.id,
      channel,
      status: "queued",
      reasons,
      caslScope: prospect.caslScope,
    });
  } catch (error) {
    console.error("[api/dispatch]", error);
    return NextResponse.json({ error: "dispatch failed" }, { status: 500 });
  }
}
