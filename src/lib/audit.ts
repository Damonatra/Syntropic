/**
 * Task 18 — the audit book's single source of truth.
 *
 * "Audits sold" per founder is DERIVED from AuditRecord rows by host
 * attribution — never stored. The `TeamMember.auditsClosed` counter remains
 * only as a stored cross-check that the reconciliation stamp verifies.
 * Joint hosting ("Damon & Josias") credits every named founder.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the host string names the member (whole word, case-insensitive). */
export function hostCreditsMember(host: string, memberName: string): boolean {
  return new RegExp(`\\b${escapeRegex(memberName)}\\b`, 'i').test(host);
}

/**
 * Derived audits-closed per member name. Records and members arrive as
 * minimal projections so both the ledger route and tests can use it.
 */
export function deriveAuditsClosed(
  records: { callHost: string }[],
  members: { name: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of members) counts[m.name] = 0;
  for (const r of records) {
    for (const m of members) {
      if (hostCreditsMember(r.callHost, m.name)) counts[m.name] += 1;
    }
  }
  return counts;
}

/**
 * Product constants for the audit book (Task 18). These lived hardcoded in
 * the client ($10,000 floor, "$50k executed", $3,500 audit) — the server now
 * owns them and ships them inside AuditRollupView (R-01: no money figure is
 * hardcoded in the presentation layer).
 */
export const AUDIT_BOOK_CONSTANTS = {
  /** Price of a 48-hour diagnostic audit briefing. */
  diagnosticAuditFeeCents: 350_000,
  /** The guaranteed recovery floor promised on every executed contract. */
  guaranteedFloorCents: 1_000_000,
  /** Executed contract value when an audit converts to a tenant. */
  contractValueCents: 5_000_000,
} as const;

/**
 * Task 20 — Syntropic's cut, single source. The rate lived as four separate
 * literals (defend route, receipts route, ledger route, reconcile route);
 * every derivation now imports this one. The reconcile `rev_share` check
 * guards the two-path math, so any drift here is provable, never silent.
 */
export const REV_SHARE_RATE = 0.2;
