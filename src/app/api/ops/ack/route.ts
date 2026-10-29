/**
 * POST /api/ops/ack — acknowledge a watchtower alert.
 *
 * Body: { key, reason? } — the exact alert key from the deck row, plus the
 * operator's verdict: "real" (default), "false_positive", or "handled".
 * Idempotent insert: acking twice is one row (ON CONFLICT DO NOTHING keeps
 * the first ack). The deck filters acked keys at snapshot time, so the ack
 * lands on the next poll. Acks suppress one window (6h, baked into the
 * key's bucket) — a condition that clears and refires later returns as a
 * fresh key. The reason rolls up into per-watch hit rates (WatchHealth) so
 * threshold tuning becomes data, not opinion.
 *
 * Raw SQL on purpose — same doctrine as the baseline ledger: the running
 * process must survive a schema push without a restart.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const Body = z.object({
  key: z.string().min(3).max(200),
  reason: z.enum(["real", "false_positive", "handled"]).default("real"),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", hint: "expected { key: string, reason?: 'real' | 'false_positive' | 'handled' }" },
      { status: 400 },
    );
  }
  try {
    const now = new Date();
    const id = `ack_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await db.$executeRawUnsafe(
      `INSERT INTO OpsAlertAck (id, alertKey, actor, reason, createdAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(alertKey) DO NOTHING`,
      id,
      parsed.data.key,
      "operator",
      parsed.data.reason,
      now,
    );
    return NextResponse.json({ ok: true, key: parsed.data.key, reason: parsed.data.reason });
  } catch (err) {
    console.error("[api/ops/ack] failed", err);
    return NextResponse.json({ error: "ack_failed" }, { status: 500 });
  }
}
