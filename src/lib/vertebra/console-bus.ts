/**
 * Console refresh bus — one write anywhere, one beat everywhere.
 *
 * The cockpit's read models used to refresh on separate clocks: the root
 * snapshot polled /api/command every 60s while the door panels (sending
 * domains, enclave connections, sourcing) fetched their own routes on
 * their own intervals — so arming a connection or spending a reveal left
 * the alert deck, the vitals and the rail badges stale until the next
 * full snapshot landed. Cause and effect lived on different screens at
 * different times, which is the opposite of frictionless.
 *
 * The bus closes that loop without merging payloads: any write path fires
 * `requestConsoleRefresh(reason)`; the cockpit root and every panel that
 * owns a read subscribe with `onConsoleRefresh` and reload on the same
 * beat. Deliberately tiny: no store, no state, no re-render of its own —
 * just a named window event. SSR/Node safe (no window → dispatch is a
 * no-op, subscription returns a no-op unsubscribe) so lib tests and any
 * future server-side import stay clean.
 */

export const CONSOLE_REFRESH_EVENT = "vertebra:console-refresh";

export interface ConsoleRefreshDetail {
  /** Which write fired the beat — "ops:ack", "sourcing:reveal", "connections:arm"… */
  reason: string;
  atMs: number;
}

/** Fire one console-wide refresh beat. `reason` names the write for debugging. */
export function requestConsoleRefresh(reason: string): void {
  if (typeof window === "undefined") return; // SSR / Node — nothing to refresh
  try {
    const detail: ConsoleRefreshDetail = { reason, atMs: Date.now() };
    window.dispatchEvent(new CustomEvent<ConsoleRefreshDetail>(CONSOLE_REFRESH_EVENT, { detail }));
  } catch {
    /* dispatch unavailable — callers keep their own load paths */
  }
}

/** Subscribe to the beat. Returns the unsubscribe. Debouncing is the caller's choice. */
export function onConsoleRefresh(handler: (detail: ConsoleRefreshDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event): void => {
    const detail = (e as CustomEvent<ConsoleRefreshDetail>).detail;
    handler(detail ?? { reason: "unknown", atMs: Date.now() });
  };
  window.addEventListener(CONSOLE_REFRESH_EVENT, listener);
  return () => window.removeEventListener(CONSOLE_REFRESH_EVENT, listener);
}
