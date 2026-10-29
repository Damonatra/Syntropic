import { describe, expect, it } from "vitest";
import { keywordClassify } from "@/lib/vertebra/reply-intent";
import { buildCaslFooter, buildEmailHeaders, unsubscribeUrl } from "@/lib/vertebra/casl";

describe("keywordClassify — deterministic triage fallback", () => {
  it("detects autoresponders first", () => {
    const c = keywordClassify("Automatic reply: I am away from the office until Monday");
    expect(c.intent).toBe("out_of_office");
    expect(c.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("explicit decline beats curiosity", () => {
    const c = keywordClassify("Interesting audit, but remove us from your list — not interested");
    expect(c.intent).toBe("not_interested");
  });

  it("collateral request without a call", () => {
    expect(keywordClassify("Send me the one-pager and I'll circulate it").intent).toBe("send_information");
  });

  it("price objection beats ERP mention when both appear", () => {
    // price keywords listed before erp keywords → deterministic precedence
    const c = keywordClassify("Your pricing is too costly for our ERP-heavy shop");
    expect(c.intent).toBe("objection_price");
  });

  it("erp objection with integration risk language", () => {
    expect(keywordClassify("We just finished an implementation, not bolting on another integration").intent).toBe("objection_erp");
  });

  it("meeting request reads as interested", () => {
    expect(keywordClassify("Can you walk our ops team through it Thursday? Let's schedule").intent).toBe("interested");
  });

  it("falls to unknown with low confidence", () => {
    const c = keywordClassify("Acknowledged.");
    expect(c.intent).toBe("unknown");
    expect(c.confidence).toBe(0.3);
  });
});

describe("CASL unsubscribe kit", () => {
  it("binds the token to prospect + address deterministically", () => {
    const a = unsubscribeUrl("p1", "ops@distributor.com");
    const b = unsubscribeUrl("p1", "ops@distributor.com");
    const c = unsubscribeUrl("p2", "ops@distributor.com");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toContain("p=p1");
    expect(a).toContain("t=");
  });

  it("CA footer carries identification + instant unsubscribe", () => {
    const footer = buildCaslFooter("p1", "ops@distributor.com", "ca");
    expect(footer).toContain("compliance@syntropic.com");
    expect(footer).toContain(unsubscribeUrl("p1", "ops@distributor.com"));
  });

  it("RFC 8058 one-click header only for CASL scope", () => {
    const ca = buildEmailHeaders("p1", "a@b.ca", true);
    const us = buildEmailHeaders("p1", "a@b.us", false);
    expect(ca["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(us["List-Unsubscribe-Post"]).toBeUndefined();
    expect(us["List-Unsubscribe"]).toBeDefined();
  });
});
