/**
 * One-time backfill (Task 19 — single source of truth for the enclave):
 * links InterceptEvent / LedgerEntry / CallSession rows to their Tenant.
 *
 * Matching rules (mirrored in scripts/seed.ts):
 *  - exact case-insensitive name match wins;
 *  - intercepts additionally accept a *unique* prefix match, because the live
 *    stream historically logged short trade names ("Apex Piping") while
 *    tenants carry full legal names ("Apex Piping & Supply");
 *  - ambiguous or unresolvable rows stay honestly unlinked (tenantId = null)
 *    and the reconcile `enclave_links` check will surface them — never guessed.
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const tenants = await db.tenant.findMany();
  const byExact = (name: string) =>
    tenants.filter((t) => t.name.toLowerCase() === name.trim().toLowerCase());
  const byPrefix = (name: string) =>
    tenants.filter((t) => t.name.toLowerCase().startsWith(name.trim().toLowerCase()));

  // ── InterceptEvent: exact, then unique prefix (trade-name tolerance) ──
  const intercepts = await db.interceptEvent.findMany();
  let linkedI = 0;
  for (const e of intercepts) {
    if (e.tenantId) continue;
    const exact = byExact(e.tenantName);
    const prefixed = exact.length === 1 ? [] : byPrefix(e.tenantName);
    const match = exact[0] ?? (prefixed.length === 1 ? prefixed[0] : undefined);
    if (match) {
      await db.interceptEvent.update({ where: { id: e.id }, data: { tenantId: match.id } });
      linkedI += 1;
      console.log(`intercept "${e.tenantName}" → tenant "${match.name}"`);
    } else {
      console.log(`intercept "${e.tenantName}" — no unique tenant match, left unlinked (honest)`);
    }
  }

  // ── LedgerEntry: exact only (money rows always carried legal names) ──
  const ledger = await db.ledgerEntry.findMany();
  let linkedL = 0;
  for (const l of ledger) {
    if (l.tenantId) continue;
    const match = byExact(l.tenantName)[0];
    if (match) {
      await db.ledgerEntry.update({ where: { id: l.id }, data: { tenantId: match.id } });
      linkedL += 1;
    } else {
      console.log(`ledger "${l.tenantName}" (${l.kind}) — no tenant match, left unlinked (honest)`);
    }
  }

  // ── CallSession: exact only; "Internal" blocks are not tenants ──
  const calls = await db.callSession.findMany();
  let linkedC = 0;
  for (const c of calls) {
    if (c.tenantId || c.clientName === 'Internal') continue;
    const match = byExact(c.clientName)[0];
    if (match) {
      await db.callSession.update({ where: { id: c.id }, data: { tenantId: match.id } });
      linkedC += 1;
    } else {
      console.log(`call "${c.clientName}" — no tenant match, left unlinked (honest)`);
    }
  }

  console.log(
    `done — intercepts ${linkedI}/${intercepts.length} · ledger ${linkedL}/${ledger.length} · calls ${linkedC}/${calls.length} linked`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
