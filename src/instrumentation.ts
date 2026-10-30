/**
 * Next.js instrumentation — the server's ignition point.
 *
 * Starts the turnaround engine's scheduler exactly once per Node process:
 * one boot tick after a 20-second settle, then every declared cadence
 * (5 minutes). Skipped on the edge runtime and during the production build
 * phase — the engine belongs to the running enclave, not to the compiler.
 *
 * Kill switch: TURNAROUND_SCHEDULER=off silences the loop without a code
 * change (the operator's RUN TICK still closes the loop by hand).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startTurnaroundScheduler } = await import("./lib/vertebra/scheduler");
  startTurnaroundScheduler();
}
