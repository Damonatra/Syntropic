/**
 * POST /api/portal/engagements/[id]/deliver — generate the audit deliverable.
 *
 * The artifact is built from REAL system data only: the engagement ledger
 * row, the intake facts, the unified leakage model output (stamped with the
 * model version), the audit cross-check when the matched prospect carries a
 * QLV score and revenue estimate, the operator's recorded verdict, the
 * sealed evidence inventory (SHA-256 per document) and the append-only
 * ledger trail verbatim. No number exists in the PDF that cannot be traced
 * to a row in this database.
 *
 * Gate: the verdict must be decided first (guaranteeCleared + confirmed
 * leakage on the ledger) — the $10,000 guarantee decision precedes the
 * deliverable, always. Regeneration overwrites the file; the ledger records
 * every generation.
 */
import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";
import { guardWrite } from "@/lib/vertebra/guard";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";
import { buildBriefPdf, sealId, type BriefLine } from "@/lib/vertebra/brief-pdf";
import { LEAKAGE_MODEL, crossCheckLeakage } from "@/lib/vertebra/leakage";

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const dateStr = (d: Date) => d.toISOString().slice(0, 10);
const stamp = (d: Date) => `${dateStr(d)} ${d.toISOString().slice(11, 16)}Z`;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = guardWrite(request, "portal/deliver", { key: false, limit: 20, windowMs: 60_000 });
  if (denied) return denied;

  const { id } = await context.params;
  try {
    const engagement = await db.engagement.findUnique({
      where: { id },
      include: {
        prospect: {
          select: {
            id: true,
            name: true,
            revenueEstimateUsd: true,
            scores: { take: 1, orderBy: { createdAt: "desc" }, select: { qlvScore: true } },
          },
        },
        documents: { orderBy: { createdAt: "asc" } },
        events: { orderBy: { createdAt: "desc" }, take: 14 },
      },
    });
    if (!engagement) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // The commitment gate mirrors PATCH stage→delivered: no artifact leaves
    // the enclave before the guarantee decision is on the ledger.
    if (engagement.guaranteeCleared == null || engagement.confirmedLeakageUsd == null) {
      return NextResponse.json(
        { error: "verdict_required", hint: "record the guarantee decision before generating the deliverable" },
        { status: 409 },
      );
    }

    // ---- model output — the same math every surface uses ------------------- //
    const hasVolume =
      engagement.intakeRfqPerMonth != null &&
      engagement.intakeLineItems != null &&
      (engagement.intakeRfqPerMonth ?? 0) > 0 &&
      (engagement.intakeLineItems ?? 0) > 0;
    const revenue = engagement.prospect?.revenueEstimateUsd ?? null;
    const qlv = engagement.prospect?.scores[0]?.qlvScore ?? null;
    const cross =
      hasVolume && revenue && qlv != null
        ? crossCheckLeakage(engagement.intakeRfqPerMonth!, engagement.intakeLineItems!, revenue, qlv)
        : null;

    const generatedAt = new Date();
    const seal = sealId(engagement.clientName, qlv, generatedAt.getTime());

    // ---- the deliverable, line by line ------------------------------------- //
    const L: BriefLine[] = [];
    const p = (text: string, opts: Partial<BriefLine> = {}) => L.push({ text, size: 10, ...opts });

    p("MARGIN DEFENSE AUDIT", { size: 17, bold: true, gapAfter: 4 });
    p(engagement.clientName, { size: 13, bold: true, gapAfter: 2 });
    p(`ref ${engagement.ref} · ${engagement.tier.replace(/_/g, " ")} · sealed ${dateStr(generatedAt)} · seal ${seal}`, {
      gapAfter: 14,
    });

    p("1. ENGAGEMENT", { size: 11, bold: true, gapAfter: 4 });
    p(`client        ${engagement.clientName}`);
    p(`domain        ${engagement.clientDomain ?? "not provided"}`);
    p(`contact       ${engagement.contactName ?? "—"}  ${engagement.contactEmail ?? ""}  ${engagement.contactPhone ?? ""}`);
    p(`fee paid      ${usd(engagement.amountUsd)}  (paid ${dateStr(engagement.paidAt)})`);
    p(`channel       ${engagement.source === "portal_webhook" ? "executive portal webhook (signed)" : "manual booking"}`);
    p(
      engagement.prospect
        ? `matched book  ${engagement.prospect.name}`
        : "matched book  not linked at time of audit",
      { gapAfter: 14 },
    );

    p("2. INTAKE PROFILE", { size: 11, bold: true, gapAfter: 4 });
    p(`rfq volume    ${engagement.intakeRfqPerMonth?.toLocaleString("en-US") ?? "—"} RFQ / month`);
    p(`line items    ${engagement.intakeLineItems?.toLocaleString("en-US") ?? "—"} lines / RFQ`);
    p(
      hasVolume
        ? `annual lines  ${Math.round(engagement.intakeRfqPerMonth! * 12 * engagement.intakeLineItems!).toLocaleString("en-US")}`
        : "annual lines  not confirmed at intake",
      { gapAfter: 14 },
    );

    p(`3. LEAKAGE MODEL — ${LEAKAGE_MODEL.version}`, { size: 11, bold: true, gapAfter: 4 });
    if (hasVolume) {
      const e = cross?.engagement;
      if (e) {
        p(`quote-volume derivation`);
        p(`  annual leakage      ${usd(e.annual)}  (band ${usd(e.low)} - ${usd(e.high)}, ±15%)`, { indent: 12 });
        p(`  recoverable yr-one  ${usd(e.recoverable)}  (${Math.round(LEAKAGE_MODEL.captureYearOne * 100)}% capture)`, {
          indent: 12,
        });
        p(`  implied revenue     ${usd(e.impliedRevenueUsd)} / yr @ ${usd(LEAKAGE_MODEL.lineValueUsd)} / line`, {
          indent: 12,
          gapAfter: 8,
        });
      }
      if (cross?.audit && cross.deltaPct != null) {
        p(`book-audit derivation (matched prospect: ${engagement.prospect?.name})`);
        p(`  annual leakage      ${usd(cross.audit.annual)}  (band ${usd(cross.audit.low)} - ${usd(cross.audit.high)}, ±15%)`, {
          indent: 12,
        });
        p(
          `  cross-check         delta ${cross.deltaPct > 0 ? "+" : ""}${cross.deltaPct}% · ${
            cross.agree ? "AGREES within ±15%" : "DIVERGES beyond ±15% — operator judgement recorded"
          }`,
          { indent: 12, gapAfter: 8 },
        );
      }
      if (!cross?.audit) {
        p(`book-audit derivation  not derivable — matched prospect lacks revenue estimate or QLV score`, {
          gapAfter: 8,
        });
      }
    } else {
      p(`quote-volume derivation  not derivable — intake volume was never confirmed`, { gapAfter: 8 });
    }
    p(`assumptions   net margin ${Math.round(LEAKAGE_MODEL.netMarginAssumption * 100)}% · exposure ceiling ${Math.round(
      LEAKAGE_MODEL.exposureCeiling * 100,
    )}% · line value ${usd(LEAKAGE_MODEL.lineValueUsd)}`, { gapAfter: 14 });

    p("4. VERDICT — THE $10,000 GUARANTEE", { size: 11, bold: true, gapAfter: 4 });
    p(`confirmed recoverable   ${usd(engagement.confirmedLeakageUsd ?? 0)}`);
    p(
      engagement.guaranteeCleared
        ? `guarantee               CLEARED — confirmed recoverable exceeds the ${usd(LEAKAGE_MODEL.guaranteeFloorUsd)} floor`
        : `guarantee               NOT CLEARED — below the ${usd(LEAKAGE_MODEL.guaranteeFloorUsd)} floor; remedy path proposed`,
      { gapAfter: 4 },
    );
    if (engagement.verdictNote) p(`operator record         ${engagement.verdictNote}`, { gapAfter: 14 });
    else p("", { gapAfter: 14 });

    p(`5. EVIDENCE INVENTORY — ${engagement.documents.length} document${engagement.documents.length === 1 ? "" : "s"}`, {
      size: 11,
      bold: true,
      gapAfter: 4,
    });
    if (engagement.documents.length === 0) {
      p("no legacy documents were sealed to this engagement; the verdict rests on intake volume and book data.", {
        gapAfter: 12,
      });
    } else {
      for (const d of engagement.documents) {
        p(
          `${d.fileName} · ${(d.sizeBytes / 1024).toFixed(1)} kb · ${d.pages ?? "?"}p · ${
            d.lineItems ?? 0
          } line items · ${d.extraction.replace(/_/g, " ")} · sha256 ${d.sha256.slice(0, 16)}`,
          { indent: 12, gapAfter: 2 },
        );
      }
      p("", { gapAfter: 12 });
    }

    p("6. LEDGER TRAIL — verbatim, append-only", { size: 11, bold: true, gapAfter: 4 });
    for (const ev of [...engagement.events].reverse()) {
      p(`[${stamp(ev.createdAt)}] ${ev.kind} · ${ev.detail ?? "(no detail)"} (${ev.actor})`, { indent: 12, gapAfter: 2 });
    }
    p("", { gapAfter: 14 });

    p("COMMERCIAL TERMS", { size: 11, bold: true, gapAfter: 4 });
    p(
      `diagnostic audit ${usd(LEAKAGE_MODEL.auditFeeUsd)}, credited to any engagement SOW · guarantee floor ${usd(
        LEAKAGE_MODEL.guaranteeFloorUsd,
      )} · enterprise SOW from ${usd(LEAKAGE_MODEL.sowFloorUsd)}`,
      { gapAfter: 2 },
    );
    p(
      `rev-share ${Math.round(LEAKAGE_MODEL.revShareRate * 100)}% of recovered margin only · model ${LEAKAGE_MODEL.version} · sealed ${seal}`,
      { gapAfter: 2 },
    );

    const pdf = buildBriefPdf(L);

    const dir = join(process.cwd(), "db", "deliverables");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${engagement.id}.pdf`);
    await writeFile(file, pdf);
    const deliverableUrl = `/api/portal/engagements/${engagement.id}/deliverable`;
    const regenerated = engagement.deliverableUrl != null;

    await db.engagement.update({ where: { id }, data: { deliverableUrl } });
    await db.engagementEvent.create({
      data: {
        engagementId: id,
        kind: "deliverable_generated",
        actor: "operator",
        detail: `${regenerated ? "regenerated" : "generated"} audit deliverable · ${(pdf.length / 1024).toFixed(1)} kb · seal ${seal}`,
      },
    });
    invalidateSnapshot();

    return NextResponse.json({ ok: true, deliverableUrl, regenerated, bytes: pdf.length, seal });
  } catch (error) {
    console.error("[api/portal/engagements/deliver] failed", error);
    return NextResponse.json({ error: "deliver_failed" }, { status: 500 });
  }
}
