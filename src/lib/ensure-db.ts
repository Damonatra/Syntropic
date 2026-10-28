import { db } from '@/lib/db';

const globalForInit = globalThis as unknown as { __syntropicDbReady?: boolean };

/**
 * One-time per-process DB init. Enables WAL journal mode so the
 * masthead "SQLite · WAL" status indicator is factually true (X-2).
 */
export async function ensureDb(): Promise<void> {
  if (globalForInit.__syntropicDbReady) return;
  try {
    await db.$executeRawUnsafe('PRAGMA journal_mode = WAL;');
  } catch {
    // WAL is an optimization; never block request handling on it.
  }
  globalForInit.__syntropicDbReady = true;
}
