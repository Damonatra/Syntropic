import { sessionTenant } from '@/lib/portal-session';
import { subscribe, type BusEvent } from '@/lib/bus';

export const dynamic = 'force-dynamic';

/**
 * GET /portal/api/bus — the client enclave's SSE push channel (Task 19).
 *
 * Same in-process bus that feeds the Tower's telemetry stream, but scoped:
 * the session cookie resolves the tenant and only that tenant's events are
 * forwarded (defense / hitl / message / thread-read). Cross-tenant events
 * and internal-only channels (notification, traffic) never leave this route.
 *
 * Events: hello (on connect), then tenant-scoped bus events. Heartbeat
 * comments every 25s keep proxies from idling the connection out.
 * 401 before the stream opens when the session is gone — the client
 * falls back to polling and re-logins on the next fetch.
 */
export async function GET() {
  const tenant = await sessionTenant();
  if (!tenant) {
    return Response.json({ error: 'Sign in required' }, { status: 401 });
  }
  const tenantName = tenant.name;

  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      send('hello', { ok: true, tenant: tenantName, ts: new Date().toISOString() });

      const scoped = (e: BusEvent) => 'tenantName' in e && e.tenantName === tenantName;

      unsub = subscribe((e: BusEvent) => {
        if (!scoped(e)) return;
        try {
          send(e.type, e);
        } catch {
          // Consumer vanished mid-write — cancel() handles teardown.
        }
      });

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          /* closed */
        }
      }, 25_000);
    },
    cancel() {
      unsub?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
