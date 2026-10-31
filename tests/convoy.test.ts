/**
 * The convoy — pure-logic tests. The db-touching path (claim pulse, pager
 * fan-out, step-1 count) is exercised live by the tick; here we pin the
 * arithmetic and the wire text so a page can never silently lie:
 *
 *   1. the call window — +2 min open, +15 min close, from the send clock
 *   2. the page body — every line an operator acts on, plain text only
 *   3. honest gaps — no phone says "pending", no hook says so, no title
 *      adds empty parens, long hooks truncate instead of flooding the page
 *   4. no markdown — the pager renders verbatim on two channels; markup
 *      would show raw asterisks to a human mid-call
 */
import { describe, expect, it } from "vitest";
import {
  CONVOY_CALL_LEAD_MIN,
  CONVOY_CALL_WINDOW_MIN,
  convoyCallWindow,
  convoyPageBody,
  convoyPageTitle,
} from "@/lib/vertebra/convoy";

describe("convoy — the human escort layer", () => {
  it("1. call window opens 2 minutes after send and closes 15 minutes after", () => {
    const sentAt = new Date("2026-10-31T14:00:00Z");
    const w = convoyCallWindow(sentAt);
    expect(w.from.getTime()).toBe(sentAt.getTime() + 2 * 60_000);
    expect(w.to.getTime()).toBe(sentAt.getTime() + 15 * 60_000);
    expect(CONVOY_CALL_LEAD_MIN).toBe(2);
    expect(CONVOY_CALL_WINDOW_MIN).toBe(15);
  });

  it("2. page body carries company, executive, hook, line, and the window", () => {
    const sentAt = new Date("2026-10-31T14:00:00Z");
    const body = convoyPageBody({
      company: "Prairie Fluid Power Ltd",
      exec: "Dana Whitfield",
      execTitle: "COO",
      hook: "Your RFQ desk is quoting 9-day turnarounds while competitors answer in 48 hours.",
      phone: "+1 403 555 0114",
      window: convoyCallWindow(sentAt),
      sentAt,
    });
    expect(body).toContain("Company: Prairie Fluid Power Ltd");
    expect(body).toContain("Executive: Dana Whitfield (COO)");
    expect(body).toContain("Direct line: +1 403 555 0114");
    expect(body).toContain("Call window: 14:02Z–14:15Z");
    expect(body).toContain("tiered autonomy");
  });

  it("3. honest gaps — missing phone, hook, and title are named, long hooks truncate", () => {
    const sentAt = new Date("2026-10-31T14:00:00Z");
    const sparse = convoyPageBody({
      company: "Northline Electric",
      exec: "R",
      execTitle: null,
      hook: null,
      phone: null,
      window: convoyCallWindow(sentAt),
      sentAt,
    });
    expect(sparse).toContain("Direct line: pending — resolve in the Dossier before dialing");
    expect(sparse).toContain("Evidence hook: none on the ledger yet");
    expect(sparse).not.toContain("()");

    const long = "x".repeat(500);
    const truncated = convoyPageBody({
      company: "C",
      exec: "E",
      execTitle: null,
      hook: long,
      phone: null,
      window: convoyCallWindow(sentAt),
      sentAt,
    });
    expect(truncated).toContain(`Evidence hook: ${"x".repeat(197)}…`);
  });

  it("4. plain text only — no markdown asterisks can reach a human mid-call", () => {
    const sentAt = new Date("2026-10-31T14:00:00Z");
    const body = convoyPageBody({
      company: "C",
      exec: "E",
      execTitle: null,
      hook: null,
      phone: null,
      window: convoyCallWindow(sentAt),
      sentAt,
    });
    expect(body).not.toContain("**");
    expect(convoyPageTitle()).toBe("CHANNEL A · EMAIL 1 OUT — touch call for Josias");
  });
});
