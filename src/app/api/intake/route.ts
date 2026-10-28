import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { assignFounder } from '@/lib/assign';
import { emit } from '@/lib/bus';
import { sendTelegramAlert } from '@/lib/telegram';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { recordTraffic } from '@/lib/traffic';
import { resolveGeo } from '@/lib/geo';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/intake — the public landing-surface intake.
 *
 * Body: { email, company, contactName?, erp?, rfqVolume?,
 *         track?: 'AUDIT_DEPOSIT' | 'STRATEGY_SESSION', attribution?, sessionId? }
 *
 * Rate-limited (10 per IP / 10 min). Every inbound is least-load assigned to
 * an online founder (lib/assign), upserted by contact email, Telegram-alerted
 * to the stream, announced on the SSE bus, and captured in the traffic funnel
 * (INTAKE_SUBMITTED). A 15-Min Strategy Session track also increments the
 * founder's discovery-call counter in the Arena.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`intake:${ip}`, 10, 10 * 60e3)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  await ensureDb();
  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  const email = String(b.email ?? '').trim().toLowerCase();
  const company = String(b.company ?? '').trim();
  if (!EMAIL_RE.test(email) || !company) {
    return NextResponse.json({ error: 'invalid_input', detail: 'A valid email and company name are required' }, { status: 422 });
  }

  const track = b.track === 'STRATEGY_SESSION' ? 'STRATEGY_SESSION' : 'AUDIT_DEPOSIT';
  const founder = await assignFounder();

  const existing = await db.tenant.findFirst({ where: { OR: [{ contactEmail: email }, { name: company }] } });
  const statusLabel = track === 'STRATEGY_SESSION' ? 'Discovery scheduled' : 'Intake received — deposit pending';
  const stageLabel = track === 'STRATEGY_SESSION' ? '15-min strategy session booked' : 'Audit deposit pending';
  const depositLabel = track === 'STRATEGY_SESSION' ? 'Strategy session — no fee yet' : 'Audit deposit pending';

  let tenant;
  if (existing) {
    tenant = await db.tenant.update({
      where: { id: existing.id },
      data: {
        contactEmail: email,
        contactName: String(b.contactName ?? '').trim() || existing.contactName,
        erp: String(b.erp ?? '').trim() || existing.erp,
        rfqMonthlyVolume: Math.max(0, Math.round(Number(b.rfqVolume ?? existing.rfqMonthlyVolume) || 0)),
        attribution: b.attribution ? JSON.stringify(b.attribution) : existing.attribution,
        assignedToId: founder.id,
        owner: founder.name,
        ...(existing.status.startsWith('Intake received') || existing.status === 'Discovery scheduled' || existing.status.startsWith('Proposal')
          ? { status: statusLabel, stage: stageLabel, depositLabel }
          : {}),
      },
    });
  } else {
    const maxSort = await db.tenant.aggregate({ _max: { sortOrder: true } });
    try {
      tenant = await db.tenant.create({
        data: {
          name: company,
          erp: String(b.erp ?? '').trim() || 'Unknown',
          status: statusLabel,
          stage: stageLabel,
          depositLabel,
          guaranteeLabel: 'Awaiting diagnostic audit',
          owner: founder.name,
          mailboxStatus: 'ACTIVE',
          contactName: String(b.contactName ?? '').trim(),
          contactEmail: email,
          rfqMonthlyVolume: Math.max(0, Math.round(Number(b.rfqVolume ?? 0) || 0)),
          attribution: b.attribution ? JSON.stringify(b.attribution) : null,
          assignedToId: founder.id,
          sortOrder: (maxSort._max.sortOrder ?? 0) + 1,
        },
      });
    } catch {
      return NextResponse.json({ error: 'conflict', detail: 'A tenant with that name already exists' }, { status: 409 });
    }
  }

  if (track === 'STRATEGY_SESSION') {
    await db.teamMember.update({
      where: { id: founder.id },
      data: { discoveryCalls: { increment: 1 } },
    });
  }

  const text =
    `NEW INGEST: ${company} — ` +
    `${track === 'AUDIT_DEPOSIT' ? 'Audit intake — deposit pending' : '15-Min Strategy Session'}` +
    ` → Assigned to ${founder.name}`;
  const delivery = await sendTelegramAlert(`📥 ${text}`);
  emit({ type: 'notification', kind: track === 'STRATEGY_SESSION' ? 'discovery' : 'audit_paid', text });

  // Phase 11.8: edge-first geo (Vercel/CF/Nginx headers → cached provider → env fallback).
  const { geo } = resolveGeo(req.headers, ip === 'local' ? null : ip);
  void recordTraffic({
    sessionId: String(b.sessionId ?? `intake:${email}`).slice(0, 64),
    layer: 'LANDING',
    eventType: 'INTAKE_SUBMITTED',
    ip,
    tenantId: tenant.name,
    geo,
    metadata: { erp: tenant.erp, volume: tenant.rfqMonthlyVolume, track },
  });

  return NextResponse.json(
    {
      ok: true,
      tenantName: tenant.name,
      assignedTo: founder.name,
      status: tenant.status,
      nextStep: track === 'AUDIT_DEPOSIT' ? 'Stripe deposit link follows intake' : 'Founder confirms the 15-min slot by email',
      alertDelivery: delivery,
    },
    { status: 201 },
  );
}
