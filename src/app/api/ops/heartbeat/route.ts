/**
 * POST /api/ops/heartbeat — the engine contract's ingress.
 *
 * The document turnaround engine (or any enrolled watch reporter) POSTs a
 * signed pulse per watch update; the watchtower renders these as first-class
 * watches alongside the native ones. Zero egress, one door in — the enclave
 * posture holds: Ops never dials out, engines report in.
 *
 * Contract:
 *   signature = HMAC-SHA256(rawBody, OPS_HEARTBEAT_SECRET), hex, sent as
 *   `x-vertebra-signature` (sha256= prefix tolerated).
 *   body: {
 *     engineId:      string  — stable engine name, e.g. "turnaround-core"
 *     pulseRef:      string  — idempotency ref (retry-safe), unique per engine
 *     watchId:       string  — which watch this pulse reports, e.g. "parse_queue"
 *     status:        "ok" | "warn" | "fail"
 *     detail?:       string  — plain words, rendered verbatim on the deck
 *     expectEveryMs?: number — declared cadence; silence past max(3×, 10min)
 *                              fires the engine_silent crit watch
 *   }
 *   → 200 { ok, deduped? }  ·  401 unsigned  ·  400 malformed
 *
 * Raw SQL on purpose — same doctrine as the baseline ledger: the running
 * process must survive a schema push without a restart.
 */
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";

const Body = z.object({
  engineId: z.string().min(2).max(80),
  pulseRef: z.string().min(1).max(120),
  watchId: z.string().min(2).max(80),
  status: z.enum(["ok", "warn", "fail"]),
  detail: z.string().max(400).optional(),
  expectEveryMs: z.number().int().positive().max(30 * 86_400_000).optional(),
});

function signatureValid(raw: string, provided: string | null): boolean {
  const secret = process.env.OPS_HEARTBEAT_SECRET;
  if (!secret || !provided) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided.trim().toLowerCase().replace(/^sha256=/, ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (!signatureValid(raw, request.headers.get("x-vertebra-signature"))) {
    return NextResponse.json(
      { error: "missing_signature", hint: "sign the raw body with HMAC-SHA256(OPS_HEARTBEAT_SECRET) in x-vertebra-signature" },
      { status: 401 },
    );
  }

  const parsed = Body.safeParse(JSON.parse(raw || "{}"));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", hint: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
      { status: 400 },
    );
  }
  const p = parsed.data;

  try {
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
    return NextResponse.json({ ok: true, deduped: res === 0, engineId: p.engineId, watchId: p.watchId });
  } catch (err) {
    console.error("[api/ops/heartbeat] failed", err);
    return NextResponse.json({ error: "heartbeat_failed" }, { status: 500 });
  }
}
