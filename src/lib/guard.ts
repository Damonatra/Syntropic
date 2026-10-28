/**
 * Shared-secret guard for machine-to-machine routes (engine webhook).
 *
 * Semantics are deliberate (mirrors the platform spec): when the key is
 * UNCONFIGURED the route stays open with a warning — dev/demo environments
 * have nothing to protect, and silently 403-ing every call makes the
 * integration impossible to debug. The moment ENGINE_WEBHOOK_KEY is set,
 * the header must match exactly or the route answers 403.
 */
export function requireSecret(req: Request, key: string | undefined, header: string) {
  if (!key) return { ok: true as const, warn: `secret unset — ${header} routes are OPEN (dev only)` };
  return req.headers.get(header) === key ? { ok: true as const } : { ok: false as const };
}
