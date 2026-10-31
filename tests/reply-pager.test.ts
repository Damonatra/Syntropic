/**
 * The reply pager — live intents wake the humans, ledger-only otherwise.
 * Pure-logic suite: intent set doctrine + the page wire text.
 */
import { describe, expect, it } from "vitest";
import { REPLY_PAGED_INTENTS, replyPageBody } from "@/lib/vertebra/replies";
import type { ReplyIntent } from "@/lib/vertebra/command";

describe("reply pager — doctrine", () => {
  it("pages the live intents only — OOO and clean declines stay ledger rows", () => {
    const live: ReplyIntent[] = ["interested", "objection_price", "objection_erp", "send_information"];
    const dead: ReplyIntent[] = ["out_of_office", "not_interested"];
    for (const intent of live) expect(REPLY_PAGED_INTENTS).toContain(intent);
    for (const intent of dead) expect(REPLY_PAGED_INTENTS).not.toContain(intent);
  });

  it("page body carries the dossier: company, score, intent, their words, the machine's move", () => {
    const body = replyPageBody({
      company: "Ironvale Pipe",
      qlvScore: 84,
      intent: "interested",
      confidence: 0.9,
      theirWords: "What does onboarding look like?",
      machineAction: "draft_pending_review",
    });
    expect(body).toContain("Ironvale Pipe");
    expect(body).toContain("QLV 84/100");
    expect(body).toContain("interested (90% confident)");
    expect(body).toContain("What does onboarding look like?");
    expect(body).toContain("parked for human review");
    expect(body).toContain("Proceed accordingly");
  });

  it("auto-sent page says the machine already acted — no duplicate human toil", () => {
    const body = replyPageBody({
      company: "Acme",
      qlvScore: null,
      intent: "send_information",
      confidence: 0.8,
      theirWords: "Send the deck",
      machineAction: "auto_sent",
    });
    expect(body).toContain("already went out");
    expect(body).not.toContain("parked");
  });

  it("long quotes truncate at 160 — pager channels render one screen, not a novel", () => {
    const body = replyPageBody({
      company: "Acme",
      qlvScore: 70,
      intent: "objection_price",
      confidence: 0.7,
      theirWords: "x".repeat(400),
      machineAction: "draft_pending_review",
    });
    const theirWords = body.split("\n").find((l) => l.startsWith("Their words:"))!;
    expect(theirWords.length).toBeLessThanOrEqual("Their words: ".length + 160);
    expect(theirWords.endsWith("…")).toBe(true);
  });
});
