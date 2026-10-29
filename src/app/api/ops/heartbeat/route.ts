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
 * The write path itself is shared with the in-process turnaround engine
 * (lib/vertebra/pulse.ts) — one row shape, one dedup key, no drift between
 * the signed HTTP door and the tick executor. Raw SQL inside the writer on
 * purpose: the running process must survive a schema push without a restart.
 */
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

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
    // The shared write path — the same raw SQL the in-process turnaround
    // engine uses. One row shape, one dedup key, no drift between doors.
    const { writeEnginePulse } = await import("@/lib/vertebra/pulse");
    const res = await writeEnginePulse(p);
    return NextResponse.json({ ok: true, deduped: res.deduped, engineId: p.engineId, watchId: p.watchId });
  } catch (err) {
    console.error("[api/ops/heartbeat] failed", err);
    return NextResponse.json({ error: "heartbeat_failed" }, { status: 500 });
  }
}
