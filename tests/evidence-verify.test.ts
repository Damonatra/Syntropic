import { describe, expect, it } from "vitest";
import { buildBrief, verifyDraft, type BriefMaterial } from "@/lib/vertebra/evidence";

const SIGNALS = [
  {
    id: "sig_1",
    kind: "review_complaint",
    verbatim: "took four days just to get a quote back on valve packages",
    context: "Google review left by a mechanical contractor",
    sourceUrl: null,
    sourceNote: "seed fixture — public review",
    confidence: "high",
  },
  {
    id: "sig_2",
    kind: "site_copy",
    verbatim: "our inside sales team will respond within 5-7 business days",
    context: "their own quote request page",
    sourceUrl: "https://example.test/quote",
    sourceNote: "seed fixture — website copy",
    confidence: "high",
  },
];

function material(overrides: Partial<BriefMaterial> = {}): BriefMaterial {
  return {
    prospectId: "test_prospect",
    companyName: "Gulf Coast Valve & Fitting",
    contactFirstName: "Marcus",
    contactFullName: "Marcus Webb",
    city: "Baton Rouge",
    stateProvince: "Louisiana",
    region: "us",
    vertical: "pvf",
    detectedErp: "QuickBooks",
    quotePortalType: "manual_mailto",
    portalHint: null,
    rawExcerpt: "Industrial PVF distributor serving the Gulf South since 1987.",
    signals: SIGNALS,
    hookBodies: ["Most distributors lose 6-14 hours per week re-keying RFQs between fax, email threads and QuickBooks."],
    rationale: "Rubric score 78/100.",
    ...overrides,
  };
}

describe("buildBrief", () => {
  it("concatenates all held material into ground truth", () => {
    const brief = buildBrief(material());
    expect(brief.groundTruth).toContain("took four days just to get a quote back");
    expect(brief.groundTruth).toContain("Baton Rouge");
    expect(brief.groundTruth).toContain("QuickBooks");
  });

  it("produces a stable briefHash that changes when evidence changes", () => {
    const a = buildBrief(material()).briefHash;
    const b = buildBrief(material()).briefHash;
    const c = buildBrief(material({ signals: [SIGNALS[0]] })).briefHash;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("verifyDraft — the integrity wall", () => {
  const brief = buildBrief(material());

  it("passes a grounded, echoing draft", () => {
    const subject = "four days to quote";
    const body = `Hi Marcus,\n\nA contractor review says quotes at Gulf Coast Valve "took four days just to get a quote back on valve packages" — meanwhile your own site promises "5-7 business days".\n\nMost PVF houses we work with lose 6-14 hours a week re-keying RFQs. Worth a look at where the delay concentrates?\n\n— sent by Syntropic`;
    const r = verifyDraft(subject, body, brief, { requireSignalEcho: true, signalVerbatims: SIGNALS.map((s) => s.verbatim) });
    expect(r.hard).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("bans template smell phrases", () => {
    const body = "Hi Marcus,\n\nI hope this email finds you well. Quick question about your quoting process — are you happy with it?";
    const r = verifyDraft("quick question", body, brief, { requireSignalEcho: false });
    const codes = r.hard.map((v) => v.code);
    expect(codes).toContain("banned_phrase");
    expect(r.ok).toBe(false);
  });

  it("refuses numbers with no basis in the brief", () => {
    const body = "Hi Marcus,\n\nWe helped a distributor cut quote turnaround by 63% last quarter. Open to seeing how?";
    const r = verifyDraft("quoting turnaround", body, brief, { requireSignalEcho: false });
    expect(r.hard.map((v) => v.code)).toContain("fact_trace_number");
  });

  it("refuses ungrounded proper nouns", () => {
    const body = "Hi Marcus,\n\nCongratulations on the Houston expansion — saw the news last week. How is the new branch quoting today?";
    const r = verifyDraft("congrats", body, brief, { requireSignalEcho: false });
    const detail = r.hard.find((v) => v.code === "fact_trace_proper_noun");
    expect(detail?.detail).toContain("Houston");
  });

  it("requires a verbatim echo in draft profile", () => {
    const body = "Hi Marcus,\n\nYour quoting desk sits at the center of every job you win. When pricing stalls, the contractor calls the next house. Want the benchmark?";
    const r = verifyDraft("quoting benchmark", body, brief, { requireSignalEcho: true, signalVerbatims: SIGNALS.map((s) => s.verbatim) });
    expect(r.hard.map((v) => v.code)).toContain("no_signal_echo");
    const r2 = verifyDraft("quoting benchmark", body, brief, { requireSignalEcho: false });
    expect(r2.ok).toBe(true);
  });

  it("caps questions and refuses manual unsubscribe text", () => {
    const body = "Hi Marcus,\n\nAre you quoting manually? Is the portal legacy? Do you want a teardown? Unsubscribe here: https://x.test/u";
    const r = verifyDraft("three questions", body, brief, { requireSignalEcho: false });
    const codes = r.hard.map((v) => v.code);
    expect(codes).toContain("question_cap");
    expect(codes).toContain("manual_unsub_link");
  });

  it("flags soft style issues without blocking", () => {
    const long = Array.from({ length: 150 }, (_, i) => (i % 2 ? "quoting" : "delay")).join(" ");
    const body = `Hi Marcus,\n\n${long}\n\nWant the benchmark?`;
    const r = verifyDraft("a perfectly reasonable subject line that runs on", body, brief, { requireSignalEcho: false });
    expect(r.ok).toBe(true);
    expect(r.soft.length).toBeGreaterThan(0);
  });
});
