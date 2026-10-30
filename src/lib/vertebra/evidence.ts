/**
 * Personalization integrity layer — the deterministic half of 1:1 cold email.
 *
 * Doctrine: a prospect feels seen when a sentence would be false for any other
 * company on the list. Specificity is a function of EVIDENCE, not prompt
 * quality. This module owns everything that must never be trusted to an LLM:
 *
 *   - the evidence brief  (verbatim PainSignals + prospect reality, hashed)
 *   - the verify engine   (banned-phrase lint, number/proper-noun fact-trace
 *                          against the brief's ground truth, structural caps)
 *
 * The LLM drafts; this layer decides what may leave the enclave. Two profiles:
 *   - draft verification: includes the `no_signal_echo` hard check (a draft
 *     that echoes no verbatim signal is not 1:1)
 *   - send verification:  no echo requirement (the operator may have edited
 *     freely) but the same hallucination rails
 */
import { z } from "zod";

// --------------------------------------------------------------------------- //
// Types
// --------------------------------------------------------------------------- //

export const PAIN_KINDS = [
  "review_complaint",
  "site_copy",
  "job_posting",
  "reply_language",
  "telemetry",
  "audit_finding",
  "operator_note",
  "research",
] as const;
export type PainKind = (typeof PAIN_KINDS)[number];

export const PAIN_KIND_LABELS: Record<PainKind, string> = {
  review_complaint: "review complaint",
  site_copy: "their site",
  job_posting: "job posting",
  reply_language: "their reply",
  telemetry: "telemetry",
  audit_finding: "audit doc",
  operator_note: "operator note",
  research: "research",
};

export interface BriefSignal {
  id: string;
  kind: string;
  verbatim: string;
  context?: string | null;
  sourceUrl?: string | null;
  sourceNote?: string | null;
  confidence?: string | null;
}

export interface EvidenceBrief {
  prospectId: string;
  companyName: string;
  contactFirstName: string | null;
  city: string | null;
  region: string | null;
  vertical: string | null;
  detectedErp: string | null;
  quotePortalType: string | null;
  portalHint: string | null;
  rawExcerpt: string | null;
  signals: BriefSignal[];
  hookBodies: string[];
  rationale: string | null;
  /** Concatenated verbatim material — the only ground a draft may stand on. */
  groundTruth: string;
  briefHash: string;
}

export interface VerifyViolation {
  code: string;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  hard: VerifyViolation[];
  soft: VerifyViolation[];
  stats: { bodyWords: number; subjectChars: number; questions: number };
}

// --------------------------------------------------------------------------- //
// Banned phrases — the template smell. Hard violations.
// --------------------------------------------------------------------------- //

const BANNED_PHRASES: Array<[string, RegExp]> = [
  ["hope-this-finds-you-well", /hope (this|all is|you are|you're|everything is)[^.!?]*(well|good|great)/i],
  ["quick-question", /\bquick question\b/i],
  ["just-following-up", /\bjust (following up|circling back|checking in|bumping this|touching base|wanted to|reaching out)\b/i],
  ["circling-back", /\b(circling back|touching base|touch base)\b/i],
  ["checking-in", /\bchecking in\b/i],
  ["wanted-to-reach-out", /\b(i wanted to reach out|reaching out to introduce|wanted to introduce myself)\b/i],
  ["came-across", /\b(i came across|i stumbled upon|i found your (company|site|website)|i noticed your company)\b/i],
  ["buzzwords", /\b(game.?changer|revolutionary|cutting.?edge|best.?in.?class|world.?class|synergy|next.?generation|disruptive)\b/i],
  ["generic-flattery", /\b(love what you(?:'| a)re doing|impressive (work|company|growth)|great (company|profile))\b/i],
  ["reminder-filler", /\b(gentle reminder|friendly reminder|as per my last email|to whom it may concern|dear sir or madam)\b/i],
  ["sorry-to-bother", /\b(sorry to bother|sorry for the (cold )?email|apologies (for|in advance))\b/i],
  ["urgent-fake", /\b(urgent|act now|limited time|don'?t miss out)\b/i],
];

// Proper nouns that may appear in any email without evidence behind them.
const NOUN_ALLOWLIST = new Set([
  "i", "i'm", "i've", "i'd", "syntropic", "syntropic's", "josias", "vertebra",
  "rfq", "rfqs", "spa", "spas", "erp", "erps", "crm", "crms", "hvac", "pvf",
  "api", "sku", "skus", "po", "pos", "roi", "kpi", "slas", "sla", "us", "usa",
  "canada", "canadian", "monday", "tuesday", "wednesday", "thursday", "friday",
  "saturday", "sunday", "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
  "north", "south", "east", "west", "the", "this", "that", "these", "those",
  "we", "our", "you", "your", "it", "its", "if", "is", "are", "do", "does",
  "most", "many", "some", "when", "where", "why", "how", "what", "who",
  "hi", "hello", "hey", "thanks", "thank", "regards", "cheers",
  "a", "an", "and", "but", "or", "so", "not", "no", "yes", "ok", "okay",
  "q1", "q2", "q3", "q4", "llc", "inc", "ltd", "co",
]);

/**
 * The standard closing every Syntropic cold email may carry. Canonical,
 * client-safe definition (casl.ts re-exports it for server callers). Listed
 * as brief boilerplate so the fact-trace never mistakes our own fixed copy
 * — "3-slide teardown" — for a fabricated claim about the prospect.
 */
export const CLOSE_CTA =
  "If this is relevant, I will send a 3-slide teardown of where the leakage shows up in a quoting workflow like yours. If not, the unsubscribe link below is instant.";

// --------------------------------------------------------------------------- //
// Brief construction (deterministic)
// --------------------------------------------------------------------------- //

export interface BriefMaterial {
  prospectId: string;
  companyName: string;
  contactFirstName?: string | null;
  contactFullName?: string | null;
  city?: string | null;
  stateProvince?: string | null;
  region?: string | null;
  vertical?: string | null;
  detectedErp?: string | null;
  quotePortalType?: string | null;
  portalHint?: string | null;
  rawExcerpt?: string | null;
  signals: BriefSignal[];
  hookBodies?: string[];
  rationale?: string | null;
  /** Fixed sender copy (the standard CTA) — legal ground, never a hallucination. */
  boilerplate?: string[];
}

function fnv1a64(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c * (i + 1), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(4).slice(0, 32);
}

export function buildBrief(m: BriefMaterial): EvidenceBrief {
  const groundTruthParts = [
    m.companyName,
    m.contactFullName,
    m.contactFirstName,
    m.city,
    m.stateProvince,
    m.region,
    m.vertical,
    m.detectedErp,
    m.quotePortalType,
    m.portalHint,
    m.rawExcerpt,
    m.rationale,
    ...(m.hookBodies ?? []),
    ...(m.boilerplate ?? []),
    ...m.signals.flatMap((s) => [s.verbatim, s.context, s.sourceNote, s.kind]),
  ].filter((x): x is string => Boolean(x && x.trim()));

  const brief: EvidenceBrief = {
    prospectId: m.prospectId,
    companyName: m.companyName,
    contactFirstName: m.contactFirstName ?? null,
    city: m.city ?? null,
    region: m.region ?? null,
    vertical: m.vertical ?? null,
    detectedErp: m.detectedErp ?? null,
    quotePortalType: m.quotePortalType ?? null,
    portalHint: m.portalHint ?? null,
    rawExcerpt: m.rawExcerpt ?? null,
    signals: m.signals,
    hookBodies: m.hookBodies ?? [],
    rationale: m.rationale ?? null,
    groundTruth: groundTruthParts.join("\n"),
    briefHash: "",
  };
  brief.briefHash = fnv1a64(
    JSON.stringify({
      companyName: brief.companyName,
      signals: brief.signals.map((s) => `${s.id}:${s.verbatim}`),
      hooks: brief.hookBodies,
      raw: brief.rawExcerpt?.slice(0, 400) ?? "",
    }),
  );
  return brief;
}

// --------------------------------------------------------------------------- //
// Fact-trace helpers
// --------------------------------------------------------------------------- //

function normalizeForTrace(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ");
}

function extractDigitTokens(text: string): string[] {
  const tokens = text.match(/\d+(?:[.,:]\d+)*/g) ?? [];
  return [...new Set(tokens.map((t) => t.replace(/,$/, "")))];
}

interface NounHit {
  noun: string;
  sentenceInitial: boolean;
  index: number;
}

function extractProperNouns(text: string): NounHit[] {
  const hits: NounHit[] = [];
  // NB: no dot in the class — a dot must terminate a match so we never span sentences.
  const re = /[A-Z][a-zA-Z&'-]*(?:\s+[A-Z][a-zA-Z&'-]*)*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const phrase = match[0];
    // Sentence-initial when preceded by nothing or a terminator — optionally
    // closed by quotes/brackets — plus whitespace. Lookbehind is 3 chars so
    // sequences like `QuickBooks.' Also` (quote after the period) resolve.
    const before = text.slice(Math.max(0, match.index - 3), match.index);
    const sentenceInitial = match.index === 0 || /[.!?\n:]["'’”)}\]]*\s*$/.test(before);
    hits.push({ noun: phrase, sentenceInitial, index: match.index });
  }
  return hits;
}

/** Sentence-initial test at an arbitrary position (shared by per-word passes). */
function isSentenceInitialAt(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text.slice(Math.max(0, index - 3), index);
  return /[.!?\n:]["'’”)}\]]*\s*$/.test(before);
}

/**
 * Contiguous-window echo test — the "feel seen" contract. A draft echoes a
 * signal when a 6-word window from its opening, middle or tail appears in
 * the body. Shared by verifyDraft, the drawer's live rails and tests so the
 * echo math exists in exactly one place.
 */
export function signalEchoed(bodyNorm: string, verbatim: string): boolean {
  const allWords = normalizeForTrace(verbatim).split(/\s+/).filter(Boolean);
  if (allWords.filter((w) => w.length > 3).length < 3) return false;
  for (const start of [0, 3, Math.max(0, allWords.length - 6)]) {
    const window = allWords.slice(start, start + 6).join(" ");
    if (window && bodyNorm.includes(window)) return true;
  }
  return false;
}

/** How many of the held signals the body actually echoes (live 1:1 depth). */
export function countEchoedSignals(body: string, verbatims: string[]): number {
  const bodyNorm = normalizeForTrace(body);
  return verbatims.reduce((n, v) => (signalEchoed(bodyNorm, v) ? n + 1 : n), 0);
}

/** True when every significant word of `phrase` appears in `haystack`. */
function phraseWordsPresent(phrase: string, haystack: string): boolean {
  const words = phrase.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return true;
  return words.every((w) => haystack.includes(w));
}

// --------------------------------------------------------------------------- //
// Verify engine
// --------------------------------------------------------------------------- //

export interface VerifyOptions {
  /** Draft profile also demands at least one echoed signal (1:1 contract). */
  requireSignalEcho?: boolean;
  /** Signal verbatims the draft may legally echo (draft profile). */
  signalVerbatims?: string[];
}

export function verifyDraft(
  subject: string,
  body: string,
  brief: EvidenceBrief,
  options: VerifyOptions = {},
): VerifyReport {
  const hard: VerifyViolation[] = [];
  const soft: VerifyViolation[] = [];
  const bodyWords = body.trim().split(/\s+/).filter(Boolean).length;
  const questions = (body.match(/\?/g) ?? []).length;
  const subjectChars = subject.length;
  const gt = normalizeForTrace(brief.groundTruth);

  // 1. banned phrases (subject + body)
  const combined = `${subject}\n${body}`;
  for (const [code, re] of BANNED_PHRASES) {
    const hit = combined.match(re);
    if (hit) hard.push({ code: "banned_phrase", detail: `${code}: "${hit[0]}"` });
  }

  // 2. fact-trace: every number must exist in the brief's ground truth
  for (const num of extractDigitTokens(combined)) {
    if (!gt.includes(normalizeForTrace(num))) {
      hard.push({ code: "fact_trace_number", detail: `"${num}" has no basis in the evidence brief` });
    }
  }

  // 3. fact-trace: proper nouns not at sentence start must exist in ground truth.
  // Whole phrase first ("Gulf Coast Valve" present → clean); otherwise flag the
  // individual words that have no basis — never the innocent company beside them.
  for (const { noun, sentenceInitial, index } of extractProperNouns(combined)) {
    const key = noun.toLowerCase();
    const firstWord = key.split(/\s+/)[0].replace(/[^a-z&'-]/g, "");
    if (NOUN_ALLOWLIST.has(firstWord)) continue;
    if (sentenceInitial && !key.includes(" ")) continue; // lone sentence opener
    if (gt.includes(normalizeForTrace(noun)) || phraseWordsPresent(noun, gt)) continue;
    const words = noun.split(/\s+/);
    if (words.length > 1) {
      // A phrase like "Gulf Coast\nNoted" can straddle a sentence boundary —
      // judge EACH word at its own position: "Gulf Coast" is grounded company
      // name, "Noted" is a legitimate sentence opener. Flag only true strangers.
      let cursor = index;
      for (const w of words) {
        const pos = combined.indexOf(w, cursor);
        cursor = pos >= 0 ? pos + w.length : cursor;
        const wl = w.toLowerCase().replace(/[^a-z&'-]/g, "");
        if (NOUN_ALLOWLIST.has(wl)) continue;
        if (gt.includes(wl)) continue;
        if (pos >= 0 && isSentenceInitialAt(combined, pos)) continue;
        hard.push({ code: "fact_trace_proper_noun", detail: `"${w}" is not grounded in the evidence brief` });
      }
    } else {
      hard.push({ code: "fact_trace_proper_noun", detail: `"${noun}" is not grounded in the evidence brief` });
    }
  }

  // 4. structural caps
  if (bodyWords > 200) hard.push({ code: "body_word_cap", detail: `${bodyWords} words — far past the 1:1 ceiling` });
  if (questions > 2) hard.push({ code: "question_cap", detail: `${questions} questions — one ask, maximum two` });
  // Pasted unsubscribe mechanics (a link, an anchor tag, header text) conflict
  // with the footer the platform appends. Prose that merely mentions the
  // unsubscribe link — including the standard CTA — is legal.
  const pastedUnsub =
    /list-unsubscribe/i.test(body) ||
    /<a\s/i.test(body) ||
    /\b(unsub\w*|opt.?out)\b[^.\n]{0,80}(https?:\/\/|www\.)/i.test(body) ||
    /(https?:\/\/|www\.)\S{0,80}\b(unsub|opt.?out)/i.test(body);
  if (pastedUnsub) {
    hard.push({ code: "manual_unsub_link", detail: "the footer is appended at send — never paste unsubscribe text into the body" });
  }

  // 5. draft profile: the echo requirement (this is the "feel seen" contract)
  if (options.requireSignalEcho) {
    const verbatims = options.signalVerbatims ?? brief.signals.map((s) => s.verbatim);
    const echoed = countEchoedSignals(body, verbatims) > 0;
    if (!echoed) {
      hard.push({ code: "no_signal_echo", detail: "draft echoes none of the verbatim pain signals — it is not 1:1" });
    }
  }

  // soft style
  if (bodyWords > 120) soft.push({ code: "body_words", detail: `${bodyWords} words — aim for ≤120` });
  if (subjectChars > 60) soft.push({ code: "subject_length", detail: `${subjectChars} chars — aim for ≤60` });
  if (/!/.test(combined)) soft.push({ code: "exclamation", detail: "exclamation marks read as marketing" });

  // dedupe identical violations (subject + body can hit the same stranger twice)
  const dedupe = (v: VerifyViolation) => `${v.code}|${v.detail}`;
  const hardUnique = [...new Map(hard.map((v) => [dedupe(v), v])).values()];
  const softUnique = [...new Map(soft.map((v) => [dedupe(v), v])).values()];

  return { ok: hardUnique.length === 0, hard: hardUnique, soft: softUnique, stats: { bodyWords, subjectChars, questions } };
}

// --------------------------------------------------------------------------- //
// Draft LLM contract (zod) — mirrors the scoring pattern
// --------------------------------------------------------------------------- //

export const DraftOut = z.object({
  subject: z.string().min(4).max(120),
  body: z.string().min(60).max(1600),
  echoedSignalId: z.string().nullable().optional(),
});
export type DraftOut = z.infer<typeof DraftOut>;

export function draftUserPrompt(brief: EvidenceBrief): string {
  const signals = brief.signals
    .map(
      (s, i) =>
        `[${i + 1}] id=${s.id} kind=${s.kind} confidence=${s.confidence ?? "medium"}\n    verbatim: "${s.verbatim}"${s.context ? `\n    context: ${s.context}` : ""}${s.sourceNote ? `\n    source: ${s.sourceNote}` : ""}`,
    )
    .join("\n");
  return `Write ONE cold email for Syntropic Industrial Growth to ${brief.companyName}${brief.contactFirstName ? ` (attn: ${brief.contactFirstName})` : ""}.

EVIDENCE BRIEF (the only reality this email may reference):
${signals || "(no signals — impossible, drafts require signals)"}
${brief.hookBodies.length ? `\nAnalyst hooks on file:\n${brief.hookBodies.map((h) => `- ${h}`).join("\n")}` : ""}

RULES:
- ≤120 words. Lead with THEIR pain, using at least one verbatim phrase from the signals (echo it in quotes or near-verbatim).
- Subject ≤60 chars, keyed to their situation — never "Quick question", never clickbait.
- Exactly one question at most. No exclamation marks. No adjectives about Syntropic. No signature block (the platform appends identity + unsubscribe).
- Every number and proper noun you write must come from the brief. If you cannot ground a claim, do not make it.
- Tone: a senior operator who has read their file, not a marketer. Plain sentences. Industrial vocabulary.

Respond with valid JSON only: {"subject": "...", "body": "...", "echoedSignalId": "<signal id you echoed or null>"}`;
}
