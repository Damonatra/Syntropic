/**
 * Domain warmup — the schedule the enclave's sending reputation lives on.
 *
 * A fresh sending domain is trusted by nobody. Mailbox providers watch the
 * volume curve: a domain that jumps from zero to two hundred cold emails a
 * day looks exactly like a spam farm, because it is one. The only honest
 * path is a ramp — a few sends a day, growing on a schedule, plateauing at
 * a volume a real business would produce. This module is that schedule.
 *
 * Pure and DB-free: everything derives from (warmupStartedAt, now). The
 * mailer gate, the ops board, and the watchtower watch all call the same
 * functions, so the cap the operator sees on the deck is the exact cap the
 * mailer enforces. Caps are derived, never stored — editing a row cannot
 * silently raise its own ceiling.
 *
 * The schedule (per sending domain, per UTC day, Channel A cold outreach):
 *
 *   day  1– 3   5/day     — introduce the domain to mailbox providers
 *   day  4– 6  10/day     — first ramp step
 *   day  7–10  20/day     — engagement should be near-zero bounce here
 *   day 11–14  30/day     — full-pattern ramp
 *   day 15+    40/day     — plateau: a defensible steady-state volume
 *
 * Forty a day per domain is deliberately conservative. Volume comes from
 * owning several warmed domains, not from pushing one past its ceiling.
 */

/** The ramp in one place: [fromDay, toDay, cap] inclusive ranges. */
const RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [1, 3, 5],
  [4, 6, 10],
  [7, 10, 20],
  [11, 14, 30],
];

export const WARMUP_PLATEAU_CAP = 40;

/** UTC midnight of `now` — cap windows are UTC days, always. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Warmup day number, 1-indexed: the day warmup started is day 1.
 * Returns null when warmup has not started (warmupStartedAt is null) or
 * somehow lies in the future — a negative day is not a day.
 */
export function warmupDay(warmupStartedAt: Date | null, now: Date): number | null {
  if (!warmupStartedAt) return null;
  const start = startOfUtcDay(warmupStartedAt).getTime();
  const today = startOfUtcDay(now).getTime();
  const day = Math.floor((today - start) / 86_400_000) + 1;
  return day >= 1 ? day : null;
}

/** Cap for a warmup day; null/negative days (not started) have no cap to speak of. */
export function capForDay(day: number | null): number | null {
  if (day == null || day < 1) return null;
  for (const [from, to, cap] of RAMP) {
    if (day >= from && day <= to) return cap;
  }
  return WARMUP_PLATEAU_CAP;
}

// --------------------------------------------------------------------------- //
// Egress gate — the mailer's third interlock, pure here, unit-tested
// --------------------------------------------------------------------------- //

/** The ledger row as the gate sees it (whatever the DB query produced). */
export interface DomainLedgerRow {
  domain: string;
  role: string; // "sending" | "transactional"
  dnsStatus: string; // pending | dns_added | verified
  status: string; // spare | warming | ready | paused | burned
  warmupStartedAt: Date | null;
}

export type EgressVerdict =
  | { ok: true; domain: string; day: number | null; cap: number | null; sentToday: number }
  | { ok: false; domain: string; reason: string; day: number | null; cap: number | null; sentToday: number };

/**
 * May mail leave the building from `row.domain` today?
 *
 * The ledger is the allowlist: an unregistered domain refuses outright —
 * if it is not in the ledger, nobody has thought about its DNS or its
 * reputation, and "nobody thought about it" is exactly what the gate
 * exists to catch. Transactional domains (operator/portal mail) skip the
 * ramp but not the DNS requirement: unverified DNS fails at the provider
 * anyway, and refusing here turns a silent 401 into a named reason.
 *
 * The gate only ever runs under live egress (RESEND key + armed enclave +
 * custom unsubscribe secret); the staged sandbox is untouched.
 */
export function resolveEgressVerdict(row: DomainLedgerRow | null, sentToday: number, now: Date): EgressVerdict {
  if (!row) {
    return { ok: false, domain: "(unregistered)", reason: "unregistered_sending_domain: every sending domain must live in the SendingDomain ledger before its first live send", day: null, cap: null, sentToday };
  }
  const day = warmupDay(row.warmupStartedAt, now);
  const cap = capForDay(day);
  const base = { domain: row.domain, day, cap, sentToday };

  if (row.dnsStatus !== "verified") {
    return { ok: false, ...base, reason: `domain_dns_unverified: ${row.domain} is dnsStatus=${row.dnsStatus} — add the DNS records and flip the status before sending` };
  }
  if (row.role === "transactional") {
    return { ok: true, ...base };
  }
  switch (row.status) {
    case "warming":
    case "ready":
      break; // the only two states that may send
    case "spare":
      return { ok: false, ...base, reason: `domain_warmup_not_started: ${row.domain} is registered but still spare — start the warmup (status=warming) before live sends` };
    case "paused":
      return { ok: false, ...base, reason: `domain_paused: ${row.domain} is on operator hold` };
    case "burned":
      return { ok: false, ...base, reason: `domain_burned: ${row.domain} is retired — do not send from it` };
    default:
      return { ok: false, ...base, reason: `domain_unknown_status: ${row.domain} carries status=${row.status}` };
  }
  if (cap != null && sentToday >= cap) {
    return { ok: false, ...base, reason: `warmup_cap_reached: ${sentToday}/${cap} today on ${row.domain} (warmup day ${day}) — the ramp is the reputation; queued dispatches wait for tomorrow` };
  }
  return { ok: true, ...base };
}

/** Human one-liner for the board / watch evidence — same math, same voice. */
export function warmupLine(day: number | null, cap: number | null, sentToday: number): string {
  if (day == null || cap == null) return "warmup not started";
  return `day ${day} · cap ${sentToday}/${cap}`;
}
