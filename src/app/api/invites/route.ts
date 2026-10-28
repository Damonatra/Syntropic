import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { generateAccessCode, codeHint } from '@/lib/invites';
import { hashCode } from '@/lib/portal-auth';
import { logCommand } from '@/lib/command-log';

export const dynamic = 'force-dynamic';

/**
 * Portal invite management — the Tower-side replacement for demo codes.
 *
 * GET  /api/invites
 *   → { invites: InviteView[], access: PortalAccessView[] }
 *     Every invite ever issued (audit trail) + current portal-access state
 *     per tenant (active code? contact email?).
 *
 * POST /api/invites { tenantName, email? }            → issue (rotate)
 *   Generates a fresh access code, supersedes all previous invites, swaps
 *   the tenant's login hash, bumps sessionEpoch (kills live sessions), and
 *   logs an EMAIL row in the Notification outbox (SIMULATED until SMTP env
 *   lands). The plaintext code appears EXACTLY once — in this response.
 *
 * POST /api/invites { tenantName, action: 'revoke' }  → disable portal access
 *   Clears the login hash, revokes open invites, bumps sessionEpoch. The
 *   next sign-in attempt answers 403 with operator guidance.
 *
 * Surface note: like every /api/* route this is the Tower-internal surface.
 * Portal clients never touch it — their cookie is scoped to /portal.
 */

function inviteView(i: {
  id: string;
  tenantName: string;
  email: string;
  codeHint: string;
  issuedBy: string;
  status: string;
  createdAt: Date;
  acceptedAt: Date | null;
}) {
  return {
    id: i.id,
    tenantName: i.tenantName,
    email: i.email,
    codeHint: i.codeHint,
    issuedBy: i.issuedBy,
    status: i.status as 'PENDING' | 'ACCEPTED' | 'REVOKED',
    createdAt: i.createdAt.toISOString(),
    acceptedAt: i.acceptedAt ? i.acceptedAt.toISOString() : null,
  };
}

export async function GET() {
  await ensureDb();
  const [invites, tenants] = await Promise.all([
    db.tenantInvite.findMany({ orderBy: { createdAt: 'desc' } }),
    db.tenant.findMany({ orderBy: { sortOrder: 'asc' }, select: { name: true, contactEmail: true, accessCodeHash: true } }),
  ]);
  return NextResponse.json({
    invites: invites.map(inviteView),
    access: tenants.map((t) => ({
      name: t.name,
      contactEmail: t.contactEmail,
      hasCode: Boolean(t.accessCodeHash),
    })),
  });
}

export async function POST(req: Request) {
  await ensureDb();
  const body = await req.json().catch(() => null);
  const tenantName = typeof body?.tenantName === 'string' ? body.tenantName.trim() : '';
  const action = typeof body?.action === 'string' ? body.action : 'issue';
  if (!tenantName) {
    return NextResponse.json({ error: 'tenantName is required' }, { status: 400 });
  }

  const tenant = await db.tenant.findUnique({ where: { name: tenantName } });
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  if (action === 'revoke') {
    const [, epochBumped] = await db.$transaction([
      db.tenantInvite.updateMany({ where: { tenantName, status: { not: 'REVOKED' } }, data: { status: 'REVOKED' } }),
      db.tenant.update({ where: { name: tenantName }, data: { accessCodeHash: '', sessionEpoch: { increment: 1 } } }),
    ]);
    await db.notification.create({
      data: {
        channel: 'SECURITY',
        target: tenantName,
        text: `Portal access disabled — active invite revoked, all enclave sessions invalidated by ${typeof body?.issuedBy === 'string' ? body.issuedBy : 'the operator'}.`,
        payload: JSON.stringify({ tenant: tenantName, kind: 'INVITE_REVOKED' }),
        deliveryStatus: 'LOGGED',
      },
    });
    await logCommand({
      actor: typeof body?.issuedBy === 'string' && body.issuedBy.trim() ? body.issuedBy.trim() : 'Operator',
      action: 'ACCESS_REVOKED',
      target: tenantName,
      detail: 'portal access disabled — active invite revoked, all enclave sessions invalidated',
    });
    return NextResponse.json({ ok: true, epochBumped: Boolean(epochBumped) });
  }

  // ── issue (rotate) ─────────────────────────────────────────────
  const providedEmail = typeof body?.email === 'string' ? body.email.trim() : '';
  const email = providedEmail || tenant.contactEmail;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { error: 'A valid email address is required to deliver the invite' },
      { status: 400 },
    );
  }

  const issuedBy = typeof body?.issuedBy === 'string' && body.issuedBy.trim() ? body.issuedBy.trim() : 'Damon';
  const code = generateAccessCode(tenantName);
  const hint = codeHint(code);

  const [, invite] = await db.$transaction([
    db.tenantInvite.updateMany({ where: { tenantName, status: { not: 'REVOKED' } }, data: { status: 'REVOKED' } }),
    db.tenantInvite.create({
      data: { tenantName, email, codeHash: hashCode(code), codeHint: hint, issuedBy, status: 'PENDING' },
    }),
    db.tenant.update({
      where: { name: tenantName },
      data: { accessCodeHash: hashCode(code), contactEmail: email, sessionEpoch: { increment: 1 } },
    }),
  ]);

  // Simulated SMTP outbox — mirrors the invite email body. deliveryStatus
  // flips to SENT automatically once SMTP env (RESEND/SES) is wired in.
  await db.notification.create({
    data: {
      channel: 'EMAIL',
      target: email,
      text: `Your Syntropic enclave invite for ${tenantName} — access code ${code}. Sign in at /portal/login. This code replaces any previous one.`,
      payload: JSON.stringify({ tenant: tenantName, email, inviteId: invite.id, kind: 'PORTAL_INVITE', code }),
      deliveryStatus: 'SIMULATED',
    },
  });

  await logCommand({
    actor: issuedBy,
    action: 'INVITE_ISSUED',
    target: tenantName,
    detail: `fresh access code issued to ${email} — previous invite superseded, outbox delivery simulated`,
  });

  return NextResponse.json({ invite: inviteView(invite), code }, { status: 201 });
}
