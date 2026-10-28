import { EventEmitter } from 'events';

/**
 * In-process backbone event bus — the push layer behind the SSE
 * telemetry stream (GET /api/telemetry/stream).
 *
 * Events are fire-and-forget fan-out to connected subscribers (deck,
 * landing surface, the client-facing enclave stream, future integrations).
 * The durable audit trail for everything emitted here already lives in
 * SQLite (InterceptEvent, HitlItem, LedgerEntry, Notification, Message) —
 * the bus never carries the only copy of a fact.
 *
 * Stored on globalThis so Next.js dev-mode module reloads keep a
 * single bus instance (same pattern as the Prisma client singleton).
 */

export type BusEvent =
  | { type: 'notification'; kind: string; text: string }
  | { type: 'defense'; tenantName: string; amountCents: number; totalDefendedCents: number }
  | { type: 'hitl'; tenantName: string; fileName: string; ref: string; count: number }
  | { type: 'traffic'; city: string | null; country: string | null; eventType: string }
  // Task 19 — direct-line presence: a message landed on a tenant thread,
  // or the team cleared the thread's unread flag (the client's "Seen").
  | { type: 'message'; tenantName: string; direction: 'client' | 'team'; sender: string; text: string }
  | { type: 'thread-read'; tenantName: string; cleared: number };

const g = globalThis as unknown as { __backboneBus?: EventEmitter };

export const bus = g.__backboneBus ?? new EventEmitter();
bus.setMaxListeners(100);
if (!g.__backboneBus) g.__backboneBus = bus;

export const emit = (e: BusEvent) => bus.emit('event', e);

/** Subscribe to every bus event; returns the unsubscribe function. */
export const subscribe = (fn: (e: BusEvent) => void) => {
  bus.on('event', fn);
  return () => bus.off('event', fn);
};
