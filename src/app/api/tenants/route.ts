import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import type { TenantView } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/tenants — live tenant + mailbox state (R-02 / R-03). */
export async function GET() {
  await ensureDb();
  const tenants = await db.tenant.findMany({ orderBy: { sortOrder: 'asc' } });
  const view: TenantView[] = tenants.map((t) => ({
    name: t.name,
    erp: t.erp,
    status: t.status,
    stage: t.stage,
    depositLabel: t.depositLabel,
    guaranteeLabel: t.guaranteeLabel,
    owner: t.owner,
    mailboxStatus: t.mailboxStatus as TenantView['mailboxStatus'],
    mailboxNote: t.mailboxNote,
    contactName: t.contactName,
    contactEmail: t.contactEmail,
  }));
  return NextResponse.json(view);
}
