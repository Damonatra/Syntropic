/**
 * Snapshot cache for /api/command — short in-memory window with ETag, plus
 * explicit invalidation when a write path changes data the snapshot carries
 * (alert acks, telemetry ingest).
 */
import { createHash } from "node:crypto";

const SNAPSHOT_TTL_MS = 5_000;

interface Entry {
  etag: string;
  body: string;
  at: number;
}

// Held on globalThis: route bundles (and dev-HMR graphs) may each load their
// own copy of this module, but they all share the process global — invalidation
// from one route is then visible to every other route.
const g = globalThis as unknown as { __vertebraSnapshot?: Entry | null };

function get(): Entry | null {
  return g.__vertebraSnapshot ?? null;
}

function set(next: Entry | null): void {
  g.__vertebraSnapshot = next;
}

export function getCachedSnapshot(ifNoneMatch: string | null): { status: 200 | 304; body: string | null; etag: string | null } {
  const entry = get();
  if (!entry || Date.now() - entry.at >= SNAPSHOT_TTL_MS) return { status: 200, body: null, etag: null };
  if (ifNoneMatch && ifNoneMatch === entry.etag) return { status: 304, body: null, etag: entry.etag };
  return { status: 200, body: entry.body, etag: entry.etag };
}

export function storeSnapshot(body: string): string {
  const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 20)}"`;
  set({ etag, body, at: Date.now() });
  return etag;
}

/** Write paths call this so the next read rebuilds instead of serving stale state. */
export function invalidateSnapshot(): void {
  set(null);
}
