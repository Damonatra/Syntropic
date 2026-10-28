import type { ScheduleSessionView, ScheduleStatus } from '@/lib/types';

/**
 * Schedule server helpers — the operating day's shared vocabulary.
 * AT-RISK is earned from live tenant distress, never set by hand; the
 * join-link provider is detected from the pasted URL (Tier 1: paste-a-link).
 */

export const TERMINAL_STATUSES: ScheduleStatus[] = ['COMPLETED', 'NO_SHOW', 'CANCELLED'];
export const SCHEDULE_STATUSES: ScheduleStatus[] = ['SCHEDULED', 'CONFIRMED', 'LIVE', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];

/** Tier-1 join links: detect the provider from the pasted URL. */
export function detectProvider(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/zoom\.(us|gov)/i.test(url)) return 'ZOOM';
  if (/meet\.google\.com/i.test(url)) return 'MEET';
  if (/teams\.microsoft\.com/i.test(url)) return 'TEAMS';
  return 'MANUAL';
}

export type TenantDistress = { name: string; paymentStatus: string; mailboxStatus: string };

/**
 * AT-RISK is earned, not typed: a client-facing block goes at-risk when its
 * tenant is payment-overdue, its mailbox is locked (dispatches will fail),
 * or a pending HITL item for that tenant has been aging for over 24 hours.
 */
export function atRiskReasons(
  session: { clientName: string; isInternal: boolean; status: string },
  tenantByName: Map<string, TenantDistress>,
  agingHitlTenants: Set<string>,
): string[] {
  if (session.isInternal || TERMINAL_STATUSES.includes(session.status as ScheduleStatus)) return [];
  const reasons: string[] = [];
  const tenant = tenantByName.get(session.clientName);
  if (tenant?.paymentStatus === 'OVERDUE') reasons.push('Payment overdue');
  if (tenant?.mailboxStatus === 'LOCKED') reasons.push('Mailbox locked — dispatches fail');
  if (agingHitlTenants.has(session.clientName)) reasons.push('HITL aging over 24h');
  return reasons;
}

export function toSessionView(
  row: {
    id: string; clientName: string; type: string; scheduledAt: Date; endsAt: Date | null; status: string;
    hostId: string | null; joinUrl: string | null; provider: string | null; notes: string;
    flagged: boolean; isInternal: boolean; attendanceVerified: boolean; verifiedAt: Date | null;
    createdAt: Date; updatedAt: Date;
  },
  hostName: string | null,
  atRisk: string[],
): ScheduleSessionView {
  return {
    id: row.id,
    clientName: row.clientName,
    type: row.type,
    scheduledAt: row.scheduledAt.toISOString(),
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    status: row.status as ScheduleStatus,
    hostId: row.hostId,
    hostName,
    joinUrl: row.joinUrl,
    provider: row.provider,
    notes: row.notes,
    flagged: row.flagged,
    isInternal: row.isInternal,
    attendanceVerified: row.attendanceVerified,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    atRiskReasons: atRisk,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** UTC-day boundaries for a YYYY-MM-DD string (the client-local day is passed in). */
export function dayRange(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);
  return { start, end };
}

export function timeLabel(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
