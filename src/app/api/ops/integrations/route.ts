/**
 * GET/POST/PATCH /api/ops/integrations — the integration registry API.
 *
 * The console surface of the star-not-mesh doctrine. GET seeds the known
 * integrations (idempotent) and returns every row joined with live env
 * truth — whether the key env var is actually set right now — plus the
 * resolution/credit roll-up for the enrich rows. POST registers a custom
 * integration. PATCH is the operator's hand: arm (a deliberate act, never
 * implied by a key appearing), retire, notes, close the circuit.
 *
 * The key VALUE never crosses this API in either direction.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { operatorFromRequest } from "@/lib/vertebra/session";
import { ensureKnownIntegrations, integrationsSnapshot } from "@/lib/vertebra/integrations";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";

const KINDS = ["egress", "inbound", "enrich", "calendar", "pager"] as const;
const AUTH_TYPES = ["api_key", "hmac", "svix", "oauth", "none"] as const;

const PostBody = z.object({
  provider: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase slug like apollo or acme-crm"),
  label: z.string().min(2).max(80).optional(),
  kind: z.enum(KINDS),
  authType: z.enum(AUTH_TYPES).default("api_key"),
  keyEnvVar: z.string().max(80).regex(/^[A-Z][A-Z0-9_]*$/, "UPPER_SNAKE env var name").nullish(),
  notes: z.string().max(500).nullish(),
});

const PatchBody = z.object({
  provider: z.string().min(2).max(64),
  status: z.enum(["staged", "armed", "degraded", "retired"]).optional(),
  circuitState: z.enum(["closed", "open"]).optional(),
  notes: z.string().max(500).nullish(),
  // operator-declared plan allowance (e.g. Apollo free tier credits) — the
  // runway math uses it as the balance when the provider reports none
  quotaRemaining: z.number().int().min(0).max(10_000_000).nullish(),
});

export async function GET() {
  try {
    const snapshot = await integrationsSnapshot();
    return NextResponse.json({ ok: true, ...snapshot });
  } catch (error) {
    console.error("[api/ops/integrations] snapshot failed", error);
    return NextResponse.json({ error: "registry_read_failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const actor = (await operatorFromRequest(request)) ?? "operator";
  const { provider, label, kind, authType, keyEnvVar, notes } = parsed.data;
  try {
    await db.integrationRecord.create({
      data: {
        provider,
        kind,
        authType,
        keyEnvVar: keyEnvVar ?? null,
        notes: notes ?? `registered by ${actor}`,
      },
    });
    invalidateSnapshot();
    return NextResponse.json({ ok: true, provider, actor, note: "registered as status=staged — arm it deliberately once its key is in the environment" });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2002" || String(error).includes("Unique constraint")) {
      return NextResponse.json({ error: "already_registered", provider }, { status: 409 });
    }
    console.error("[api/ops/integrations] create failed", error);
    return NextResponse.json({ error: "register_failed" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const actor = (await operatorFromRequest(request)) ?? "operator";
  const { provider, status, circuitState, notes, quotaRemaining } = parsed.data;
  if (!status && !circuitState && notes === undefined && quotaRemaining === undefined) {
    return NextResponse.json({ error: "nothing_to_update", hint: "pass status, circuitState, notes, or quotaRemaining" }, { status: 400 });
  }

  const data: { status?: string; circuitState?: string; notes?: string | null; consecutiveFailures?: number; quotaRemaining?: number | null; quotaUpdatedAt?: Date } = {};
  if (status) data.status = status;
  if (notes !== undefined) data.notes = notes;
  if (quotaRemaining !== undefined) {
    data.quotaRemaining = quotaRemaining;
    data.quotaUpdatedAt = new Date();
  }
  if (circuitState === "closed") data.consecutiveFailures = 0; // closing the circuit forgives the streak
  if (circuitState) data.circuitState = circuitState;

  try {
    await ensureKnownIntegrations();
    const row = await db.integrationRecord.update({ where: { provider }, data });
    invalidateSnapshot();
    return NextResponse.json({
      ok: true,
      provider: row.provider,
      status: row.status,
      circuitState: row.circuitState,
      actor,
      ...(status === "armed"
        ? { note: `armed by ${actor} — the gate still refuses when the key env var is unset, so arming without a key fails closed at call time` }
        : {}),
      ...(quotaRemaining !== undefined ? { note: `quota declared by ${actor} — runway math uses it as the balance` } : {}),
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2025") {
      return NextResponse.json({ error: "not_registered", provider }, { status: 404 });
    }
    console.error("[api/ops/integrations] patch failed", error);
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
}
