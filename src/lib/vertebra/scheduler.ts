/**
 * The turnaround scheduler — the engine's pulse, in-process.
 *
 * Why in-process: the enclave's posture is zero egress, one door in. The
 * document turnaround engine is not a second service to babysit — it is
 * this Node process doing its own work on a clock and reporting through
 * the same heartbeat contract an external engine would. The silence watch
 * needs a cadence to guard; this loop is that cadence.
 *
 * Registration: instrumentation.ts register() → once per server process.
 * The handle lives on globalThis so a dev-time module re-evaluation can
 * never double-start the loop. Ticks are failure-isolated: a crashed tick
 * pulses fail on the "tick" watch and the loop continues — a dead loop is
 * the silence watch's story, told by missing beats, not by a thrown timer.
 */

import { runTurnaroundTick } from "./tick";
import { TURNAROUND_CADENCE_MS, TURNAROUND_ENGINE_ID, pulseRef } from "./turnaround";
import { writeEnginePulse } from "./pulse";

const BOOT_DELAY_MS = 20_000;

interface SchedulerGlobal {
  __vertebraSchedulerStarted?: boolean;
}

const g = globalThis as SchedulerGlobal;

async function runScheduledTick(): Promise<void> {
  try {
    const out = await runTurnaroundTick();
    const line = `[turnaround] tick — ${out.scanned} active · ${out.advanced} advanced · ${out.rendered} rendered · ${out.failures} failed · guard ${out.guard.status}`;
    console.log(`${line} — ${out.guard.detail}`);
  } catch (err) {
    console.error("[turnaround] scheduled tick crashed", err);
    // The engine's distress signal — a fail pulse the deck rings immediately.
    try {
      await writeEnginePulse({
        engineId: TURNAROUND_ENGINE_ID,
        pulseRef: pulseRef("tick", Date.now()),
        watchId: "tick",
        status: "fail",
        detail: `scheduled tick crashed — ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`,
        expectEveryMs: TURNAROUND_CADENCE_MS,
      });
    } catch {
      // Even the distress signal failed — the silence watch will speak.
    }
  }
}

export function startTurnaroundScheduler(): void {
  if (g.__vertebraSchedulerStarted) return;
  if (process.env.TURNAROUND_SCHEDULER === "off") return;
  g.__vertebraSchedulerStarted = true;

  const boot = setTimeout(() => {
    void runScheduledTick();
    const h = setInterval(() => void runScheduledTick(), TURNAROUND_CADENCE_MS);
    h.unref?.(); // never hold the process open for the clock's sake
  }, BOOT_DELAY_MS);
  boot.unref?.();
}
