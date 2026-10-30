/**
 * Domain warmup — the schedule and the egress gate verdicts.
 *
 * Every case is a way a fresh (or tired) sending domain tries to leave the
 * building, and the verdict it must get: the ramp is the reputation, the
 * ledger is the allowlist, and the gate fails closed.
 */
import { describe, expect, it } from "vitest";
import {
  capForDay,
  resolveEgressVerdict,
  startOfUtcDay,
  warmupDay,
  WARMUP_PLATEAU_CAP,
  type DomainLedgerRow,
} from "@/lib/vertebra/warmup";

// Fixed reference instants — deterministic UTC days, no locale drift.
const DAY0 = new Date("2026-11-02T12:00:00.000Z"); // a Monday, mid-day
const LATER_SAME_DAY = new Date("2026-11-02T23:59:59.999Z");
const NEXT_DAY = new Date("2026-11-03T09:00:00.000Z");

function row(overrides: Partial<DomainLedgerRow> = {}): DomainLedgerRow {
  return {
    domain: "send.example.com",
    role: "sending",
    dnsStatus: "verified",
    status: "warming",
    warmupStartedAt: DAY0,
    ...overrides,
  };
}

describe("startOfUtcDay", () => {
  it("truncates to UTC midnight regardless of wall-clock time", () => {
    expect(startOfUtcDay(DAY0).toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(startOfUtcDay(LATER_SAME_DAY).toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(startOfUtcDay(NEXT_DAY).toISOString()).toBe("2026-11-03T00:00:00.000Z");
  });
});

describe("warmupDay", () => {
  it("is null when warmup never started", () => {
    expect(warmupDay(null, DAY0)).toBeNull();
  });

  it("is null for a start date in the future — a negative day is not a day", () => {
    expect(warmupDay(new Date("2026-11-03T00:00:00.000Z"), DAY0)).toBeNull();
  });

  it("counts the start day as day 1 and rolls at UTC midnight", () => {
    expect(warmupDay(DAY0, DAY0)).toBe(1);
    expect(warmupDay(DAY0, LATER_SAME_DAY)).toBe(1);
    expect(warmupDay(DAY0, NEXT_DAY)).toBe(2);
    expect(warmupDay(DAY0, new Date("2026-11-16T00:00:00.000Z"))).toBe(15);
  });
});

describe("capForDay", () => {
  it("walks the published ramp", () => {
    expect(capForDay(1)).toBe(5);
    expect(capForDay(3)).toBe(5);
    expect(capForDay(4)).toBe(10);
    expect(capForDay(6)).toBe(10);
    expect(capForDay(7)).toBe(20);
    expect(capForDay(10)).toBe(20);
    expect(capForDay(11)).toBe(30);
    expect(capForDay(14)).toBe(30);
    expect(capForDay(15)).toBe(WARMUP_PLATEAU_CAP);
    expect(capForDay(365)).toBe(WARMUP_PLATEAU_CAP);
  });

  it("gives no cap to a day that does not exist", () => {
    expect(capForDay(null)).toBeNull();
    expect(capForDay(0)).toBeNull();
    expect(capForDay(-4)).toBeNull();
  });
});

describe("resolveEgressVerdict", () => {
  const now = DAY0; // warmup day 1 → cap 5

  it("refuses a domain the ledger has never heard of", () => {
    const v = resolveEgressVerdict(null, 0, now);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("unregistered_sending_domain");
  });

  it("refuses any role through unverified DNS — the provider would 401 it anyway", () => {
    for (const role of ["sending", "transactional"] as const) {
      const v = resolveEgressVerdict(row({ role, dnsStatus: "pending" }), 0, now);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain("domain_dns_unverified");
    }
  });

  it("lets transactional mail through once DNS is verified — no ramp on operator mail", () => {
    const v = resolveEgressVerdict(row({ role: "transactional" }), 999, now);
    expect(v.ok).toBe(true);
  });

  it("refuses a spare domain — registered but warmup not started", () => {
    const v = resolveEgressVerdict(row({ status: "spare", warmupStartedAt: null }), 0, now);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("domain_warmup_not_started");
  });

  it("refuses paused and burned domains outright", () => {
    const paused = resolveEgressVerdict(row({ status: "paused" }), 0, now);
    const burned = resolveEgressVerdict(row({ status: "burned" }), 0, now);
    expect(paused.ok).toBe(false);
    expect(burned.ok).toBe(false);
    if (!paused.ok) expect(paused.reason).toContain("domain_paused");
    if (!burned.ok) expect(burned.reason).toContain("domain_burned");
  });

  it("enforces the day-1 cap: 5 allowed, the 6th refuses", () => {
    expect(resolveEgressVerdict(row(), 4, now).ok).toBe(true);
    const v = resolveEgressVerdict(row(), 5, now);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("warmup_cap_reached");
      expect(v.reason).toContain("5/5");
      expect(v.reason).toContain("day 1");
    }
  });

  it("scales the cap with the ramp — day 11 allows 30", () => {
    const day11 = new Date("2026-11-12T15:00:00.000Z");
    expect(resolveEgressVerdict(row(), 29, day11).ok).toBe(true);
    expect(resolveEgressVerdict(row(), 30, day11).ok).toBe(false);
  });

  it("carries the math on the verdict so the refuser can show its work", () => {
    const v = resolveEgressVerdict(row(), 3, now);
    expect(v).toMatchObject({ ok: true, domain: "send.example.com", day: 1, cap: 5, sentToday: 3 });
  });
});
