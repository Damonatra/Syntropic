/**
 * Quote Leakage Vulnerability scoring for the console.
 *
 * Primary path: the sandbox LLM via z-ai-web-dev-sdk with a strict JSON
 * contract (zod-validated). Fallback path: the deterministic rubric — the
 * same transparent degradation the Python engine ships
 * (`vertebra/ai/scorer.py`). Both paths are real scoring logic; neither
 * fabricates prospects.
 */
import { z } from "zod";
import { formatRevenue } from "./classify";

export const FACTOR_KEYS = [
  "rfq_latency",
  "legacy_portal",
  "unapplied_spa",
  "manual_quoting_share",
  "vertical_fit",
  "size_fit",
] as const;

export const FACTOR_WEIGHTS: Record<(typeof FACTOR_KEYS)[number], number> = {
  rfq_latency: 0.28,
  legacy_portal: 0.22,
  unapplied_spa: 0.18,
  manual_quoting_share: 0.14,
  vertical_fit: 0.1,
  size_fit: 0.08,
};

export const FACTOR_LABELS: Record<(typeof FACTOR_KEYS)[number], string> = {
  rfq_latency: "RFQ latency",
  legacy_portal: "Legacy portal",
  unapplied_spa: "Unapplied SPAs",
  manual_quoting_share: "Manual quoting share",
  vertical_fit: "Vertical fit",
  size_fit: "Size fit",
};

export type QLVBand = "low" | "medium" | "high" | "critical";

export function bandForScore(score: number): QLVBand {
  if (score >= 85) return "critical";
  if (score >= 65) return "high";
  if (score >= 40) return "medium";
  return "low";
}

export const CHANNEL_A_MIN_SCORE = 70;

export const HookFlavor = z.enum(["rfq_latency", "spa_leakage", "portal_drift", "peer_proof"]);
export type HookFlavor = z.infer<typeof HookFlavor>;

export interface QLVFactor {
  key: (typeof FACTOR_KEYS)[number];
  weight: number;
  points: number;
  evidence: string;
}

export interface Hook {
  flavor: HookFlavor;
  body: string;
}

export interface ScoreOutcome {
  qlvScore: number;
  band: QLVBand;
  factors: QLVFactor[];
  hooks: Hook[];
  rationale: string;
  model: string;
  fingerprint: string;
}

export interface ScoringPayload {
  prospectId: string;
  companyName: string;
  vertical: string | null;
  region: string | null;
  revenueEstimateUsd: number | null;
  employeeCount: number | null;
  detectedErp: string | null;
  portalHint: string | null;
  notes: string | null;
}

export function fingerprint(payload: ScoringPayload): string {
  const canonical = JSON.stringify({ ...payload, prospectId: undefined }, Object.keys(payload).sort());
  // FNV-1a 64-bit-ish hex — stable, dependency-free, console cache key.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c * (i + 1), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(4).slice(0, 32);
}

// --------------------------------------------------------------------------- #
// z-ai structured scoring
// --------------------------------------------------------------------------- #

const LLMFactor = z.object({
  key: z.enum(FACTOR_KEYS),
  points: z.number().min(0).max(100),
  evidence: z.string().min(10).max(400),
});
const LLMHook = z.object({ flavor: HookFlavor, body: z.string().min(40).max(600) });
const LLMOut = z.object({
  qlv_score: z.number().int().min(1).max(100),
  factors: z.array(LLMFactor).min(4).max(6),
  hooks: z.array(LLMHook).min(2).max(3),
  rationale: z.string().min(40).max(1200),
});

const SYSTEM_PROMPT = `You are Syntropic's senior industrial-distribution analyst. You score US and Canada distributors (PVF, Electrical, HVAC, Fluid Power) on Quote Leakage Vulnerability: how much revenue a company likely loses because manual RFQ handling, legacy customer portals and unapplied vendor SPAs push quotes out late or mispriced.
Rules:
- Ground every factor in the evidence provided; never invent ERPs, portals or numbers.
- 1-39 healthy quoting operation; 40-64 visible leakage; 65-84 structural leakage; 85-100 active bleed.
- Weight factors with these anchors: rfq_latency 0.28, legacy_portal 0.22, unapplied_spa 0.18, manual_quoting_share 0.14, vertical_fit 0.10, size_fit 0.08.
- Hooks must reference manual RFQ latency or unapplied vendor SPAs concretely, 40-80 words, no exclamation marks, no greetings, no flattery.
Respond with valid JSON only, matching exactly this shape:
{"qlv_score": <int 1-100>, "factors": [{"key": "...", "points": <0-100>, "evidence": "..."}], "hooks": [{"flavor": "rfq_latency|spa_leakage|portal_drift|peer_proof", "body": "..."}], "rationale": "..."}`;

function contextBlock(p: ScoringPayload): string {
  return [
    `Company: ${p.companyName}`,
    `Vertical: ${p.vertical ?? "unknown"}`,
    `Region: ${p.region ?? "unknown"}`,
    `Revenue estimate: ${p.revenueEstimateUsd ? formatRevenue(p.revenueEstimateUsd) : "unknown"}`,
    `Employee count: ${p.employeeCount ?? "unknown"}`,
    `Detected ERP: ${p.detectedErp ?? "none detected"}`,
    `Legacy portal signals: ${p.portalHint ?? "none"}`,
    p.notes ? `Field notes: ${p.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function scoreWithLLM(payload: ScoringPayload): Promise<ScoreOutcome | null> {
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: SYSTEM_PROMPT },
        { role: "user", content: `Score this distributor for Quote Leakage Vulnerability.\n\n${contextBlock(payload)}` },
      ],
      thinking: { type: "disabled" },
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;
    const jsonText = raw.replace(/```json|```/g, "").trim();
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const parsed = LLMOut.safeParse(JSON.parse(jsonText.slice(start, end + 1)));
    if (!parsed.success) return null;
    const data = parsed.data;
    return {
      qlvScore: data.qlv_score,
      band: bandForScore(data.qlv_score),
      factors: data.factors.map((f) => ({ ...f, weight: FACTOR_WEIGHTS[f.key] })),
      hooks: data.hooks,
      rationale: data.rationale,
      model: "console-llm-claude-class",
      fingerprint: fingerprint(payload),
    };
  } catch (error) {
    console.warn("[vertebra] LLM scoring unavailable, using rubric fallback:", error);
    return null;
  }
}

// --------------------------------------------------------------------------- #
// Deterministic rubric fallback (parity with vertebra/ai/scorer.py)
// --------------------------------------------------------------------------- #

const ERP_RISK: Array<[string, number]> = [
  ["quickbooks", 88], ["sage", 78], ["odoo", 72], ["eclipse", 62], ["epicor", 58],
  ["syspro", 55], ["s2k", 55], ["infor", 50], ["netsuite", 48], ["acumatica", 46],
  ["prophet 21", 45], ["p21", 45], ["dynamics", 42], ["sap", 35], ["oracle", 38],
];

const VERTICAL_FIT: Record<string, number> = { pvf: 95, fluid_power: 90, hvac: 80, electrical: 70 };

export function rubricScore(payload: ScoringPayload): ScoreOutcome {
  const erp = (payload.detectedErp ?? "").toLowerCase();
  const portal = (payload.portalHint ?? "").toLowerCase();
  const erpPoints = erp ? (ERP_RISK.find(([sig]) => erp.includes(sig))?.[1] ?? 40) : 30;
  const portalPoints = portal ? 85 : erp.includes("portal") ? Math.min(90, erpPoints + 15) : 20;
  let rfqPoints = Math.min(100, erpPoints * 0.6 + portalPoints * 0.4);
  if (payload.vertical === "hvac") rfqPoints += 5;
  const verticalFit = payload.vertical ? (VERTICAL_FIT[payload.vertical] ?? 40) : 40;
  const revenue = payload.revenueEstimateUsd ?? 0;
  const sizeFit = revenue ? (revenue >= 20_000_000 && revenue <= 100_000_000 ? 100 : 70) : 35;

  const factors: QLVFactor[] = [
    { key: "rfq_latency", weight: FACTOR_WEIGHTS.rfq_latency, points: rfqPoints, evidence: `ERP=${payload.detectedErp ?? "unknown"}, portal signals=${payload.portalHint ?? "none"}` },
    { key: "legacy_portal", weight: FACTOR_WEIGHTS.legacy_portal, points: portalPoints, evidence: `legacy portal evidence: ${payload.portalHint ?? "none detected"}` },
    { key: "unapplied_spa", weight: FACTOR_WEIGHTS.unapplied_spa, points: Math.min(95, erpPoints + 20), evidence: `SPA enforcement typically absent on ${payload.detectedErp ?? "manual stacks"}` },
    { key: "manual_quoting_share", weight: FACTOR_WEIGHTS.manual_quoting_share, points: erpPoints, evidence: `quoting maturity inferred from ${payload.detectedErp ?? "absent ERP signal"}` },
    { key: "vertical_fit", weight: FACTOR_WEIGHTS.vertical_fit, points: verticalFit, evidence: `vertical=${payload.vertical ?? "unknown"} (RFQ complexity fit)` },
    { key: "size_fit", weight: FACTOR_WEIGHTS.size_fit, points: sizeFit, evidence: revenue ? `revenue ${formatRevenue(revenue)}` : "revenue unknown" },
  ];
  const total = Math.max(1, Math.min(100, Math.round(factors.reduce((sum, f) => sum + f.points * f.weight, 0))));

  const hooks: Hook[] = [];
  const ranked = [...factors].sort((a, b) => b.points * b.weight - a.points * a.weight);
  for (const f of ranked.slice(0, 3)) {
    if (f.key === "rfq_latency") {
      hooks.push({ flavor: "rfq_latency", body: `Most ${f.evidence} distributors we talk to lose 6-14 hours per week re-keying RFQs between fax, email threads and ${payload.detectedErp ?? "their quoting system"}. If a quote request sits longer than a day at ${payload.companyName}, the contractor has already called the next house. Worth 15 minutes to see the numbers?` });
    } else if (f.key === "unapplied_spa") {
      hooks.push({ flavor: "spa_leakage", body: `Quick observation about ${payload.companyName}: ${f.evidence} — when vendor SPAs sit unapplied, every quote either leaks margin or prices you out. We built an engine that flags SPA gaps before the quote goes out the door. Open to a look?` });
    } else if (f.key === "legacy_portal") {
      hooks.push({ flavor: "portal_drift", body: `${payload.companyName} still runs quoting through ${f.evidence}. Teams on those portals tell us the same story: status lives in someone's inbox, and customers call asking where their RFQ went. There is a cleaner way to run this.` });
    } else if (f.key === "manual_quoting_share") {
      hooks.push({ flavor: "rfq_latency", body: `${f.evidence} — that manual quoting load is exactly where quote leakage starts at distributors like ${payload.companyName}. We automate the intake-to-quote path without touching your ERP. Interested in the benchmark?` });
    }
  }
  if (hooks.length === 0) {
    hooks.push({ flavor: "peer_proof", body: `We just helped a distributor with a profile close to ${payload.companyName} cut quote turnaround from two days to under three hours. Happy to share how it worked — no pitch deck, just the workflow.` });
  }

  return {
    qlvScore: total,
    band: bandForScore(total),
    factors,
    hooks,
    rationale: `Rubric score ${total}/100 for ${payload.companyName}: ${factors.map((f) => `${f.key.replace(/_/g, " ")} ${Math.round(f.points)}/100`).join("; ")}. Degraded-mode rubric applied because the LLM was unavailable; evidence strings cite the ingested firmographics only.`,
    model: "vertebra-rubric-1.0",
    fingerprint: fingerprint(payload),
  };
}

export async function scoreProspect(payload: ScoringPayload): Promise<ScoreOutcome> {
  const llm = await scoreWithLLM(payload);
  return llm ?? rubricScore(payload);
}
