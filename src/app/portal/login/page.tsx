import type { Metadata } from 'next';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import PortalLogin from '@/components/backbone/portal-login';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Enclave sign-in — Layer 3 Client Portal',
  description: 'Sign in to your Syntropic executive enclave.',
};

export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string }>;
}) {
  const { tenant } = await searchParams;
  await ensureDb();
  const tenants = await db.tenant.findMany({ orderBy: { sortOrder: 'asc' }, select: { name: true } });
  const preselect = tenant && tenants.some((t) => t.name === tenant) ? tenant : undefined;

  return <PortalLogin tenants={tenants.map((t) => t.name)} preselect={preselect} />;
}
