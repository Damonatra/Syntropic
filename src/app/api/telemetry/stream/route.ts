import { subscribe, type BusEvent } from '@/lib/bus';

export const dynamic = 'force-dynamic';

/**
 * GET /api/telemetry/stream — Server-Sent Events push channel for the
 * backbone bus. Events: hello (on connect), defense, notification, hitl.
 * Heartbeat comments every 25s keep proxies from idling the connection out.
 *
 * The Command Tower keeps its 2s/6s polling loops (authoritative reconcile);
 * this stream is the low-latency push layer for the deck banner, the landing
 * surface, and any external observer.
 */
export async function GET() {
  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      send('hello', { ok: true, ts: new Date().toISOString() });
      unsub = subscribe((e: BusEvent) => {
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
