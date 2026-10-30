/**
 * The audit brief, as lines — the single composition both renderers share.
 *
 * Why this module exists: the deliverable must never depend on who renders
 * it. The operator's button (POST /api/portal/engagements/[id]/deliver) and
 * the turnaround engine's tick both call buildAuditBriefLines, so the
 * artifact the operator proof-reads is byte-for-byte the doctrine the
 * engine renders — one contract, two hands.
 *
 * Every number below traces to a row: the engagement ledger, the intake
 * facts, the unified leakage model (version-stamped), the cross-check when
 * the matched book carries revenue + QLV, and the append-only trail
 * verbatim. Nothing invented, nothing colored.
 *
 * Pure logic only: no DB, no React. Takes a structural row — satisfied by
 * the Prisma composite both callers load.
 */

import { sealId, type BriefLine } from "./brief-pdf";
import { LEAKAGE_MODEL, crossCheckLeakage } from "./leakage";

export interface BriefSourceRow {
  ref: string;
  clientName: string;
  clientDomain: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  tier: string;
  amountUsd: number;
  source: string;
  paidAt: Date;
  intakeRfqPerMonth: number | null;
  intakeLineItems: number | null;
  guaranteeCleared: boolean | null;
  confirmedLeakageUsd: number | null;
  verdictNote: string | null;
  prospect: { name: string; revenueEstimateUsd: number | null; scores: Array<{ qlvScore: number | null }> } | null;
  documents: Array<{
    fileName: string;
    sizeBytes: number;
    pages: number | null;
    lineItems: number | null;
    extraction: string;
    sha256: string;
  }>;
  events: Array<{ createdAt: Date; kind: string; detail: string | null; actor: string }>;
}

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const dateStr = (d: Date) => d.toISOString().slice(0, 10);
const stamp = (d: Date) => `${dateStr(d)} ${d.toISOString().slice(11, 16)}Z`;

/** Builds the full line script and its content-bound seal. */
export function buildAuditBriefLines(
  e: BriefSourceRow,
  generatedAt: Date,
): { lines: BriefLine[]; seal: string } {
  const qlv = e.prospect?.scores[0]?.qlvScore ?? null;
  const seal = sealId(e.clientName, qlv, generatedAt.getTime());

  // ---- model output — the same math every surface uses ------------------- //
  const hasVolume =
    e.intakeRfqPerMonth != null && e.intakeLineItems != null && (e.intakeRfqPerMonth ?? 0) > 0 && (e.intakeLineItems ?? 0) > 0;
  const revenue = e.prospect?.revenueEstimateUsd ?? null;
  const cross =
    hasVolume && revenue && qlv != null ? crossCheckLeakage(e.intakeRfqPerMonth!, e.intakeLineItems!, revenue, qlv) : null;

  const L: BriefLine[] = [];
  const p = (text: string, opts: Partial<BriefLine> = {}) => L.push({ text, size: 10, ...opts });

  p("MARGIN DEFENSE AUDIT", { size: 17, bold: true, gapAfter: 4 });
  p(e.clientName, { size: 13, bold: true, gapAfter: 2 });
  p(`ref ${e.ref} · ${e.tier.replace(/_/g, " ")} · sealed ${dateStr(generatedAt)} · seal ${seal}`, {
    gapAfter: 14,
  });

  p("1. ENGAGEMENT", { size: 11, bold: true, gapAfter: 4 });
  p(`client        ${e.clientName}`);
  p(`domain        ${e.clientDomain ?? "not provided"}`);
  p(`contact       ${e.contactName ?? "—"}  ${e.contactEmail ?? ""}  ${e.contactPhone ?? ""}`);
  p(`fee paid      ${usd(e.amountUsd)}  (paid ${dateStr(e.paidAt)})`);
  p(`channel       ${e.source === "portal_webhook" ? "executive portal webhook (signed)" : "manual booking"}`);
  p(e.prospect ? `matched book  ${e.prospect.name}` : "matched book  not linked at time of audit", { gapAfter: 14 });

  p("2. INTAKE PROFILE", { size: 11, bold: true, gapAfter: 4 });
  p(`rfq volume    ${e.intakeRfqPerMonth?.toLocaleString("en-US") ?? "—"} RFQ / month`);
  p(`line items    ${e.intakeLineItems?.toLocaleString("en-US") ?? "—"} lines / RFQ`);
  p(
    hasVolume
      ? `annual lines  ${Math.round(e.intakeRfqPerMonth! * 12 * e.intakeLineItems!).toLocaleString("en-US")}`
      : "annual lines  not confirmed at intake",
    { gapAfter: 14 },
  );

  p(`3. LEAKAGE MODEL — ${LEAKAGE_MODEL.version}`, { size: 11, bold: true, gapAfter: 4 });
  if (hasVolume) {
    const m = cross?.engagement;
    if (m) {
      p(`quote-volume derivation`);
      p(`  annual leakage      ${usd(m.annual)}  (band ${usd(m.low)} - ${usd(m.high)}, ±15%)`, { indent: 12 });
      p(`  recoverable yr-one  ${usd(m.recoverable)}  (${Math.round(LEAKAGE_MODEL.captureYearOne * 100)}% capture)`, {
        indent: 12,
      });
      p(`  implied revenue     ${usd(m.impliedRevenueUsd)} / yr @ ${usd(LEAKAGE_MODEL.lineValueUsd)} / line`, {
        indent: 12,
        gapAfter: 8,
      });
    }
    if (cross?.audit && cross.deltaPct != null) {
      p(`book-audit derivation (matched prospect: ${e.prospect?.name})`);
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
  p(`confirmed recoverable   ${usd(e.confirmedLeakageUsd ?? 0)}`);
  p(
    e.guaranteeCleared
      ? `guarantee               CLEARED — confirmed recoverable exceeds the ${usd(LEAKAGE_MODEL.guaranteeFloorUsd)} floor`
      : `guarantee               NOT CLEARED — below the ${usd(LEAKAGE_MODEL.guaranteeFloorUsd)} floor; remedy path proposed`,
    { gapAfter: 4 },
  );
  if (e.verdictNote) p(`operator record         ${e.verdictNote}`, { gapAfter: 14 });
  else p("", { gapAfter: 14 });

  p(`5. EVIDENCE INVENTORY — ${e.documents.length} document${e.documents.length === 1 ? "" : "s"}`, {
    size: 11,
    bold: true,
    gapAfter: 4,
  });
  if (e.documents.length === 0) {
    p("no legacy documents were sealed to this engagement; the verdict rests on intake volume and book data.", {
      gapAfter: 12,
    });
  } else {
    for (const d of e.documents) {
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
  for (const ev of [...e.events].reverse()) {
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

  return { lines: L, seal };
}
