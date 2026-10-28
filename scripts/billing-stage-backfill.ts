/**
 * One-time backfill (Task 20 — the client money panel's lifecycle fact):
 * derives Tenant.billingStage from the fee-ledger shape, the same way the
 * seed's derivation block does.
 *
 * Rules (documented honestly — the money's state IS the stage, the column
 * is the founder-set fact the ledger cross-checks):
 *  - SETUP_FEE sum >= contract value AND paymentStatus PAID  → LIVE
 *  - any SETUP_FEE collected but contract not yet complete    → SETUP
 *  - AUDIT_FEE present (audit paid, setup not started)        → AUDIT
 *  - no fee rows at all                                       → DISCOVERY
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

/** AUDIT_BOOK_CONSTANTS.contractValueCents — inlined to keep this script dependency-free. */
const CONTRACT_VALUE_CENTS = 5_000_000;

function deriveStage(setupSumCents: number, hasAuditFee: boolean, paymentStatus: string): string {
  if (setupSumCents >= CONTRACT_VALUE_CENTS && paymentStatus === 'PAID') return 'LIVE';
  if (setupSumCents > 0) return 'SETUP';
  if (hasAuditFee) return 'AUDIT';
  return 'DISCOVERY';
}

async function main() {
  const tenants = await db.tenant.findMany({ include: { ledgerRows: true } });
  const counts: Record<string, number> = {};
  for (const t of tenants) {
    const fees = t.ledgerRows.filter((l) => l.kind === 'SETUP_FEE' || l.kind === 'AUDIT_FEE');
    const setupSum = fees
      .filter((l) => l.kind === 'SETUP_FEE')
      .reduce((s, l) => s + l.amountCents, 0);
    const hasAuditFee = fees.some((l) => l.kind === 'AUDIT_FEE');
    const stage = deriveStage(setupSum, hasAuditFee, t.paymentStatus);
    if (stage !== t.billingStage) {
      await db.tenant.update({ where: { id: t.id }, data: { billingStage: stage } });
    }
    counts[stage] = (counts[stage] ?? 0) + 1;
    console.log(`${t.name}: ${t.billingStage} → ${stage}${stage !== t.billingStage ? ' (updated)' : ''}`);
  }
  console.log('stage counts:', counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
