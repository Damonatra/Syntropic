import { db } from '@/lib/db';

/**
 * The Ship's Log — append-only command journal.
 *
 * logCommand never throws and never blocks the command it records: a logging
 * failure must not break a live HITL approval or a target edit. Fire, forget,
 * and keep the station moving.
 */
export async function logCommand(entry: {
  actor: string;
  action:
    | 'TARGET_ADJUSTED'
    | 'HITL_ACTION'
    | 'INVITE_ISSUED'
    | 'ACCESS_REVOKED'
    | 'MESSAGE_SENT'
    | 'RFQ_SIMULATED'
    | 'RECONCILED'
    | 'SCHEDULED'
    | 'RESCHEDULED'
    | 'STATUS_CHANGED'
    | 'REASSIGNED'
    | 'LINK_ATTACHED'
    | 'ATTENDANCE_VERIFIED'
    | 'FOUNDER_UNAVAILABLE'
    | 'FOUNDER_RETURNED';
  target?: string;
  detail?: string;
}): Promise<void> {
  try {
    await db.commandLog.create({
      data: {
        actor: entry.actor,
        action: entry.action,
        target: entry.target ?? '',
        detail: entry.detail ?? '',
      },
    });
  } catch {
    // The journal is a feature of trust, not a dependency of operations.
  }
}

/** Human verb for a HITL action, used in the journal detail line. */
export function hitlVerb(action: string): string {
  switch (action) {
    case 'APPROVE':
      return 'approved & dispatched';
    case 'OVERRIDE':
      return 'manually overrode';
    case 'RETRY':
      return 'retried dispatch for';
    default:
      return 'resolved';
  }
}
