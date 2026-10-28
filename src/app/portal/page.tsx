import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { sessionTenant } from '@/lib/portal-session';
import EnclavePortal from '@/components/backbone/enclave-portal';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'The Enclave — Layer 3 Client Portal',
  description:
    'Client-facing executive enclave: live margin recovery feed, direct line to your Syntropic team, guarantee status, and upcoming executive calls.',
};

export default async function PortalPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string }>;
}) {
  const { tenant } = await searchParams;

  const session = await sessionTenant();
  if (!session) {
    // Deep links from the Backbone (e.g. /portal?tenant=Midwest Trade Wholesale)
    // pre-select the company on the sign-in screen. Expired/rotated sessions
    // land here the same way.
    redirect(tenant ? `/portal/login?tenant=${encodeURIComponent(tenant)}` : '/portal/login');
  }

  return (
    <EnclavePortal tenantName={session.name} contactName={session.contactName || 'Client'} />
  );
}
