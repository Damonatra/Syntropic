/**
 * Deterministic reply-intent keyword classifier — console parity of the
 * fallback path in vertebra/ai/reply_agent.py. Runs when the LLM is
 * unreachable; never blocks triage.
 */
import type { ReplyIntent } from "./command";

export interface KeywordClassification {
  intent: ReplyIntent;
  confidence: number;
  rationale: string;
}

export function keywordClassify(text: string): KeywordClassification {
  const blob = text.toLowerCase();
  const has = (...words: string[]) => words.some((w) => blob.includes(w));
  if (has("out of office", "automatic reply", "auto-reply", "away from the office", "on leave")) {
    return { intent: "out_of_office", confidence: 0.85, rationale: "Keyword fallback: autoresponder phrasing detected." };
  }
  if (has("not interested", "take us off", "remove us", "unsubscribe", "stop contacting", "no thank you")) {
    return { intent: "not_interested", confidence: 0.85, rationale: "Keyword fallback: explicit decline phrasing." };
  }
  if (has("send me", "send the", "one-pager", "more information", "pricing doc", "brochure", "circulate")) {
    return { intent: "send_information", confidence: 0.8, rationale: "Keyword fallback: collateral request detected." };
  }
  if (has("expensive", "too costly", "3x", "roi", "your pricing", "your price", "budget")) {
    return { intent: "objection_price", confidence: 0.78, rationale: "Keyword fallback: cost/ROI objection detected." };
  }
  if (has("erp", "netsuite", "sap", "eclipse", "p21", "prophet", "quickbooks", "integration", "implementation")) {
    return { intent: "objection_erp", confidence: 0.78, rationale: "Keyword fallback: ERP/integration objection detected." };
  }
  if (has("interested", "call me", "schedule", "thursday", "meeting", "walk us", "let's talk", "book")) {
    return { intent: "interested", confidence: 0.8, rationale: "Keyword fallback: engagement request detected." };
  }
  return { intent: "unknown", confidence: 0.3, rationale: "Keyword fallback: no decisive signal." };
}
