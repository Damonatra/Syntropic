/**
 * POST /api/ops/ack — acknowledge a watchtower alert.
 *
 * Body: { key } — the exact alert key from the deck row. Idempotent insert:
 * acking twice is one row (ON CONFLICT DO NOTHING keeps the first ack). The
 * deck filters acked keys at snapshot time, so the ack lands on the next
 * poll. Acks suppress one window (6h, baked into the key's bucket) — a
 * condition that clears and refires later returns as a fresh key.
 *
 * Raw SQL on purpose — same doctrine as the baseline ledger: the running
 * process must survive a schema push without a restart.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const Body = z.object({ key: z.string().min(3).max(200) });

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", hint: "expected { key: string }" }, { status: 400 });
  }
  try {
    const now = new Date();
    const id = `ack_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await db.$executeRawUnsafe(
      `INSERT INTO OpsAlertAck (id, alertKey, actor, createdAt) VALUES (?, ?, ?, ?)
       ON CONFLICT(alertKey) DO NOTHING`,
      id,
      parsed.data.key,
      "operator",
      now,
    );
    return NextResponse.json({ ok: true, key: parsed.data.key });
  } catch (err) {
    console.error("[api/ops/ack] failed", err);
    return NextResponse.json({ error: "ack_failed" }, { status: 500 });
  }
}
