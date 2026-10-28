/**
 * One-time backfill (Task 18 — single source of truth for audits):
 * links every AuditRecord to its Tenant by exact case-insensitive name
 * match. Unmatched rows stay honestly unlinked (tenantId = null) —
 * "not yet a tenant" is a real state, never guessed.
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

/** Same attribution rule as src/lib/audit.ts (word-boundary, case-insensitive). */
function hostCredits(host: string, memberName: string): boolean {
  return new RegExp(`\\b${memberName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(host);
}

async function main() {
  const [audits, tenants, members] = await Promise.all([
    db.auditRecord.findMany(),
    db.tenant.findMany(),
    db.teamMember.findMany(),
  ]);
  let linked = 0;
  for (const a of audits) {
    if (a.tenantId) continue;
    const t = tenants.find((x) => x.name.toLowerCase() === a.companyName.toLowerCase());
    if (t) {
      await db.auditRecord.update({ where: { id: a.id }, data: { tenantId: t.id } });
      linked += 1;
      console.log(`linked "${a.companyName}" → tenant "${t.name}"`);
    } else {
      console.log(`no tenant match for "${a.companyName}" — left unlinked (honest)`);
    }
  }
  console.log(`done — ${linked}/${audits.length} audits linked`);

  // Sync stored auditsClosed counters to the derived truth (joint hosts credit
  // every named founder). The counter survives only as the reconcile cross-check.
  for (const m of members) {
    const derived = audits.filter((a) => hostCredits(a.callHost, m.name)).length;
    if (m.auditsClosed !== derived) {
      await db.teamMember.update({ where: { id: m.id }, data: { auditsClosed: derived } });
      console.log(`counter synced — ${m.name}: ${m.auditsClosed} → ${derived}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
