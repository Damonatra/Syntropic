/**
 * The turnaround + sequence scheduler — the engine's pulse, in-process.
 *
 * Why in-process: the enclave's posture is zero egress, one door in. The
 * engines are not services to babysit — they are this Node process doing
 * their own work on a clock and reporting through the same heartbeat
 * contract an external engine would. The silence watch needs a cadence to
 * guard; these loops are that cadence.
 *
 * Two loops, one clock:
 *   · runTurnaroundTick — the document turnaround engine (its own cadence)
 *   · runSequenceTick   — the outreach loop: fast-lane intake + Channel A
 *     sends, every 90 s, so a qualified prospect waits for no operator.
 *     The /api/cron/tick door and the operator's RUN TICK stay equivalent
 *     entries — the fast-lane's 90 s ledger claim makes concurrent
 *     triggers absorb, never double-admit.
 *
 * Registration: instrumentation.ts register() → once per server process.
 * The handle lives on globalThis so a dev-time module re-evaluation can
 * never double-start the loop. Ticks are failure-isolated: a crashed tick
 * pulses fail on the "tick" watch and the loop continues — a dead loop is
 * the silence watch's story, told by missing beats, not by a thrown timer.
 */

import { runSequenceTick, runTurnaroundTick } from "./tick";
import { TURNAROUND_CADENCE_MS, TURNAROUND_ENGINE_ID, pulseRef } from "./turnaround";
import { writeEnginePulse } from "./pulse";

const BOOT_DELAY_MS = 20_000;
const SEQUENCE_CADENCE_MS = 90_000;
const SEQUENCE_ENGINE_ID = "sequence-loop";

interface SchedulerGlobal {
  __vertebraSchedulerStarted?: boolean;
}

const g = globalThis as SchedulerGlobal;

async function runScheduledTurnaroundTick(): Promise<void> {
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

async function runScheduledSequenceTick(): Promise<void> {
  try {
    const out = await runSequenceTick();
    const fl = out.fastlane;
    const detail = `sent ${out.sent} · due ${out.due} · failed ${out.failed} · fastlane ${
      fl ? (fl.armed ? `armed, admitted ${fl.admitted}/${fl.scanned} scanned` : "disarmed") : "scan crashed"
    }`;
    console.log(`[sequence] tick — ${detail}`);
    await writeEnginePulse({
      engineId: SEQUENCE_ENGINE_ID,
      pulseRef: `tick:${Math.floor(Date.now() / SEQUENCE_CADENCE_MS)}`,
      watchId: "tick",
      status: out.failed > 0 ? "warn" : "ok",
      detail,
      expectEveryMs: SEQUENCE_CADENCE_MS,
    });
  } catch (err) {
    console.error("[sequence] scheduled tick crashed", err);
    try {
      await writeEnginePulse({
        engineId: SEQUENCE_ENGINE_ID,
        pulseRef: `tick:${Math.floor(Date.now() / SEQUENCE_CADENCE_MS)}`,
        watchId: "tick",
        status: "fail",
        detail: `scheduled tick crashed — ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`,
        expectEveryMs: SEQUENCE_CADENCE_MS,
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
    void runScheduledTurnaroundTick();
    const h = setInterval(() => void runScheduledTurnaroundTick(), TURNAROUND_CADENCE_MS);
    h.unref?.(); // never hold the process open for the clock's sake
    void runScheduledSequenceTick();
    const hs = setInterval(() => void runScheduledSequenceTick(), SEQUENCE_CADENCE_MS);
    hs.unref?.();
  }, BOOT_DELAY_MS);
  boot.unref?.();
}
