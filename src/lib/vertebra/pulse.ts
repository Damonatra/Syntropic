/**
 * Engine pulse writer — the single write path into the heartbeat contract.
 *
 * The signed HTTP door (/api/ops/heartbeat) is for engines that live outside
 * the enclave process. The turnaround engine lives inside it: POSTing to
 * itself over loopback would be theater, so the executor writes pulses
 * through this helper — the exact same raw SQL, the exact same dedup key,
 * the exact same row shape. Raw SQL on purpose, same doctrine as the
 * heartbeat route: the running process must survive a schema push without a
 * restart.
 *
 * Dedup: UNIQUE(engineId, pulseRef) — a retry inside the same pulseRef
 * window is absorbed, never double-counted by the vitals strip.
 */

import { db } from "@/lib/db";

export interface PulseInput {
  engineId: string;
  pulseRef: string;
  watchId: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  expectEveryMs?: number;
}

/** Writes a pulse; returns false when the (engineId, pulseRef) pair deduped. */
export async function writeEnginePulse(p: PulseInput): Promise<{ ok: true; deduped: boolean }> {
  const now = new Date();
  const id = `pl_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const res = await db.$executeRawUnsafe(
    `INSERT INTO EnginePulse (id, engineId, pulseRef, watchId, status, detail, expectEveryMs, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(engineId, pulseRef) DO NOTHING`,
    id,
    p.engineId,
    p.pulseRef,
    p.watchId,
    p.status,
    p.detail ?? null,
    p.expectEveryMs ?? null,
    now,
  );
  return { ok: true, deduped: res === 0 };
}
