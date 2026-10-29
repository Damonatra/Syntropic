/**
 * GET /api/dossier/brief?id=… — the sealed Quote Leakage Audit Brief.
 *
 * Server-rendered PDF (hand-rolled, no deps) assembled from the prospect's
 * score, ERP profile and the unified leakage model. This is the deliverable
 * artifact the $3,500 Diagnostic Audit sells — every number traces to the
 * model card, and the seal id binds company + score + timestamp.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildBriefPdf, sealId, type BriefLine } from "@/lib/vertebra/brief-pdf";
import { auditLeakage, LEAKAGE_MODEL } from "@/lib/vertebra/leakage";
import { PORTAL_LABELS } from "@/lib/vertebra/command";

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });

    const prospect = await db.prospect.findUnique({
      where: { id },
      include: {
        scores: { orderBy: { createdAt: "desc" }, take: 1 },
        cluster: true,
        contacts: { take: 1 },
      },
    });
    if (!prospect) return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });

    const score = prospect.scores[0];
    if (!score) return NextResponse.json({ error: "prospect_unscored" }, { status: 409 });

    const factors = JSON.parse(score.factorsJson) as Array<{ key: string; weight: number; points: number; evidence: string }>;
    const hooks = JSON.parse(score.hooksJson) as Array<{ flavor: string; body: string }>;
    const erp = (() => {
      try {
        return prospect.erpMetadata ? (JSON.parse(prospect.erpMetadata) as { detected_erp?: string; recommended_pitch_angle?: string }) : null;
      } catch {
        return null;
      }
    })();

    const leakage = auditLeakage(prospect.revenueEstimateUsd, score.qlvScore);
    const generatedAtMs = Date.now();
    const seal = sealId(prospect.name, score.qlvScore, generatedAtMs);

    const lines: BriefLine[] = [
      { text: "SYNTROPIC // MARGIN DEFENSE", size: 9, bold: true },
      { text: "QUOTE LEAKAGE AUDIT BRIEF — SEALED", size: 20, bold: true, gapAfter: 4 },
      { text: `model ${LEAKAGE_MODEL.version} · seal ${seal} · ${new Date(generatedAtMs).toISOString().slice(0, 10)}`, size: 8, gapAfter: 14 },

      { text: prospect.name.toUpperCase(), size: 14, bold: true },
      {
        text: `${prospect.city ?? "—"}, ${prospect.stateProvince ?? ""} ${prospect.country ?? ""} · ${prospect.vertical?.toUpperCase() ?? "—"} · ${
          prospect.revenueEstimateUsd ? `est. revenue ${usd(prospect.revenueEstimateUsd)}` : "revenue estimate pending"
        }`,
        size: 9,
        gapAfter: 4,
      },
      {
        text: `cluster: ${prospect.cluster?.clusterName ?? "unassigned"} · quoting via ${PORTAL_LABELS[prospect.quotePortalType ?? "undetermined"] ?? "undetermined"}`,
        size: 9,
        gapAfter: 14,
      },

      { text: "1. THE VERDICT", size: 11, bold: true },
      {
        text: leakage
          ? `Annual net-margin leakage: ${usd(leakage.annual)}  (band ${usd(leakage.low)} - ${usd(leakage.high)}, ±15%)`
          : "Annual leakage: pending — revenue estimate not on file",
        size: 12,
        bold: true,
      },
      {
        text: leakage
          ? `Recoverable in year one at ${LEAKAGE_MODEL.captureYearOne * 100}% capture: ${usd(leakage.recoverable)} · audit-to-recovery multiple: ${(leakage.recoverable / LEAKAGE_MODEL.auditFeeUsd).toFixed(1)}x`
          : "Recovery estimate follows the revenue audit.",
        size: 9,
        gapAfter: 14,
      },

      { text: "2. LEAKAGE ANATOMY — QLV FACTORS", size: 11, bold: true },
      { text: `Quote Leakage Vulnerability: ${score.qlvScore}/100 · band ${score.band.toUpperCase()} · scored by ${score.model}`, size: 9, gapAfter: 6 },
      ...factors.map((f) => ({
        text: `${f.key.replace(/_/g, " ")}  ·  weight ${(f.weight * 100).toFixed(0)}%  ·  points ${f.points}/100 — ${f.evidence}`,
        size: 8.5,
        indent: 10,
        gapAfter: 2,
      })),
      { text: "", size: 4, gapAfter: 10 },

      { text: "3. SYSTEMS PROFILE", size: 11, bold: true },
      {
        text: `ERP on file: ${erp?.detected_erp ?? prospect.detectedErp ?? "none detected"} · quote portal: ${PORTAL_LABELS[prospect.quotePortalType ?? "undetermined"] ?? "undetermined"}`,
        size: 9,
        gapAfter: 2,
      },
      ...(erp?.recommended_pitch_angle
        ? [{ text: `Pitch angle: ${erp.recommended_pitch_angle}`, size: 8.5, indent: 10, gapAfter: 2 }]
        : []),
      { text: "", size: 4, gapAfter: 10 },

      { text: "4. WHERE THE LEAKAGE SHOWS UP", size: 11, bold: true },
      { text: score.rationale, size: 9, gapAfter: 10 },

      ...(hooks.length > 0
        ? ([{ text: "5. FIRST-MEETING HOOKS", size: 11, bold: true }] as BriefLine[]).concat(
            hooks.slice(0, 3).map((h) => ({ text: `[${h.flavor.replace(/_/g, " ")}] ${h.body}`, size: 8.5, indent: 10, gapAfter: 3 })),
          )
        : []),

      { text: "", size: 8, gapAfter: 16 },
      { text: "ENGAGEMENT TERMS", size: 11, bold: true },
      {
        text: `Diagnostic Audit ${usd(LEAKAGE_MODEL.auditFeeUsd)} — credited dollar-for-dollar against the Enterprise SOW (${usd(LEAKAGE_MODEL.sowFloorUsd)}).`,
        size: 9,
        gapAfter: 2,
      },
      {
        text: `Margin Leakage Recovery Guarantee: if the audit does not surface at least ${usd(LEAKAGE_MODEL.guaranteeFloorUsd)} in recoverable leakage, remediation continues until it does.`,
        size: 9,
        gapAfter: 2,
      },
      {
        text: `Net-margin rev-share ${LEAKAGE_MODEL.revShareRate * 100}%: the engine participates in recovered margin only. The distributor keeps ${100 - LEAKAGE_MODEL.revShareRate * 100}%.`,
        size: 9,
        gapAfter: 12,
      },

      { text: "SCOPE & METHOD", size: 9, bold: true },
      {
        text: `Figures derive from ${LEAKAGE_MODEL.version}: net-margin assumption ${(LEAKAGE_MODEL.netMarginAssumption * 100).toFixed(0)}%, exposure ceiling ${(LEAKAGE_MODEL.exposureCeiling * 100).toFixed(0)}% of net margin, QLV factor weights fixed at 28/22/18/14/10/8 (rfq_latency, legacy_portal, unapplied_spa, manual_quoting_share, vertical_fit, size_fit).`,
        size: 8,
        gapAfter: 2,
      },
      {
        text: `Prepared for ${prospect.contacts[0] ? `${prospect.contacts[0].firstName} ${prospect.contacts[0].lastName}` : "the operating principal"}${prospect.caslScope ? " · CASL scope: one-click unsubscribe enforced on all sends" : ""}.`,
        size: 8,
        gapAfter: 2,
      },
      {
        text: `Seal ${seal} binds this brief to ${prospect.name} at QLV ${score.qlvScore} on ${new Date(generatedAtMs).toISOString().slice(0, 10)}. Re-verification requires a fresh audit.`,
        size: 8,
      },
    ];

    const pdf = buildBriefPdf(lines);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="vertebra-brief-${prospect.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[api/dossier/brief] failed", error);
    return NextResponse.json({ error: "brief_failed" }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
