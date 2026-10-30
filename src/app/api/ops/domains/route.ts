/**
 * GET/POST/PATCH /api/ops/domains — the sending-domain ledger API.
 *
 * The console surface of the egress gate. GET returns every registered
 * domain joined with the live numbers the warmup gate itself uses (UTC-day
 * cap, sends counted today, 7-day hard-bounce rate, queued backlog) — the
 * board renders exactly the math the mailer enforces, never a parallel
 * truth. POST registers a domain (buy-day step 1). PATCH advances
 * dnsStatus / warmup status — the operator's hands on the ramp.
 *
 * Attribution follows the house convention: the signed session names the
 * actor; "operator" only when the gate is off (sandbox).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { operatorFromRequest } from "@/lib/vertebra/session";
import { capForDay, startOfUtcDay, warmupDay, WARMUP_PLATEAU_CAP } from "@/lib/vertebra/warmup";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";

const DNS_STATUSES = ["pending", "dns_added", "verified"] as const;
const DOMAIN_STATUSES = ["spare", "warming", "ready", "paused", "burned"] as const;

const PostBody = z.object({
  domain: z
    .string()
    .min(4)
    .max(253)
    .regex(/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/, "must be a lowercase hostname like send.example.com"),
  role: z.enum(["sending", "transactional"]).default("sending"),
  notes: z.string().max(500).nullish(),
});

const PatchBody = z.object({
  domain: z.string().min(4).max(253),
  dnsStatus: z.enum(DNS_STATUSES).optional(),
  status: z.enum(DOMAIN_STATUSES).optional(),
  notes: z.string().max(500).nullish(),
});

export async function GET() {
  const now = new Date();
  const dayStart = startOfUtcDay(now);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  const [rows, todayByDomain, weekByDomain, backlogByDomain, bounced] = await Promise.all([
    db.sendingDomain.findMany({ orderBy: [{ role: "asc" }, { domain: "asc" }] }),
    db.dispatch.groupBy({
      by: ["fromDomain"],
      where: { fromDomain: { not: null }, status: { in: ["sent", "delivered", "opened"] }, updatedAt: { gte: dayStart } },
      _count: { _all: true },
    }),
    db.dispatch.groupBy({
      by: ["fromDomain"],
      where: { fromDomain: { not: null }, updatedAt: { gte: weekAgo }, status: { in: ["sent", "delivered", "opened", "failed"] } },
      _count: { _all: true },
    }),
    db.dispatch.groupBy({
      by: ["fromDomain"],
      where: { fromDomain: { not: null }, status: "queued" },
      _count: { _all: true },
    }),
    db.dispatch.groupBy({
      by: ["fromDomain"],
      where: { fromDomain: { not: null }, status: "failed", updatedAt: { gte: weekAgo }, error: { contains: "bounce" } },
      _count: { _all: true },
    }),
  ]);

  const sentMap = new Map(todayByDomain.map((r) => [r.fromDomain as string, r._count._all]));
  const weekMap = new Map(weekByDomain.map((r) => [r.fromDomain as string, r._count._all]));
  const bounceMap = new Map(bounced.map((r) => [r.fromDomain as string, r._count._all]));
  const backlogMap = new Map(backlogByDomain.map((r) => [r.fromDomain as string, r._count._all]));

  const domains = rows.map((row) => {
    const day = warmupDay(row.warmupStartedAt, now);
    const cap = row.role === "sending" ? capForDay(day) : null;
    const sentToday = sentMap.get(row.domain) ?? 0;
    const sends7d = weekMap.get(row.domain) ?? 0;
    const hardBounces7d = bounceMap.get(row.domain) ?? 0;
    return {
      domain: row.domain,
      role: row.role,
      dnsStatus: row.dnsStatus,
      status: row.status,
      warmupStartedAt: row.warmupStartedAt?.toISOString() ?? null,
      warmupDay: day,
      cap,
      sentToday,
      sends7d,
      hardBounces7d,
      bounceRate7d: sends7d > 0 ? Number((hardBounces7d / sends7d).toFixed(3)) : null,
      queuedBacklog: backlogMap.get(row.domain) ?? 0,
      providerRef: row.providerRef,
      notes: row.notes,
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  // Dispatch rows pointing at a domain nobody registered — the gate refuses
  // them at send time; the operator sees them here before the tick bleeds.
  const allByDomain = await db.dispatch.groupBy({
    by: ["fromDomain"],
    where: { fromDomain: { not: null } },
    _count: { _all: true },
  });
  const registeredSet = new Set(rows.map((r) => r.domain));
  const unknownDomains = allByDomain
    .filter((r) => r.fromDomain && !registeredSet.has(r.fromDomain))
    .map((r) => ({ domain: r.fromDomain as string, dispatches: r._count._all }));

  return NextResponse.json({ ok: true, domains, unknownDomains, plateauCap: WARMUP_PLATEAU_CAP, generatedAt: now.toISOString() });
}

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = PostBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const actor = (await operatorFromRequest(request)) ?? "operator";
  try {
    const row = await db.sendingDomain.create({
      data: {
        domain: parsed.data.domain,
        role: parsed.data.role,
        notes: parsed.data.notes ?? null,
      },
    });
    invalidateSnapshot();
    return NextResponse.json({ ok: true, domain: row.domain, actor, note: "registered as dnsStatus=pending — add the DNS records, then flip to dns_added / verified" });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2002" || String(error).includes("Unique constraint")) {
      return NextResponse.json({ error: "already_registered", domain: parsed.data.domain }, { status: 409 });
    }
    console.error("[api/ops/domains] create failed", error);
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
  const { domain, dnsStatus, status, notes } = parsed.data;
  if (!dnsStatus && !status && notes === undefined) {
    return NextResponse.json({ error: "nothing_to_update", hint: "pass dnsStatus, status, or notes" }, { status: 400 });
  }

  const data: {
    dnsStatus?: string;
    status?: string;
    notes?: string | null;
    // starting warmup stamps the clock — the ramp derives from it
    warmupStartedAt?: Date;
  } = {};
  if (dnsStatus) data.dnsStatus = dnsStatus;
  if (notes !== undefined) data.notes = notes;
  if (status) {
    data.status = status;
    // Warming for the first time stamps warmupStartedAt; re-pausing and
    // resuming does NOT reset the clock — the ramp already walked is kept.
    if (status === "warming") {
      const row = await db.sendingDomain.findUnique({ where: { domain }, select: { warmupStartedAt: true } });
      if (row && !row.warmupStartedAt) data.warmupStartedAt = new Date();
    }
  }

  try {
    const row = await db.sendingDomain.update({ where: { domain }, data });
    invalidateSnapshot();
    return NextResponse.json({
      ok: true,
      domain: row.domain,
      status: row.status,
      dnsStatus: row.dnsStatus,
      warmupStartedAt: row.warmupStartedAt?.toISOString() ?? null,
      actor,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2025") {
      return NextResponse.json({ error: "not_registered", domain }, { status: 404 });
    }
    console.error("[api/ops/domains] patch failed", error);
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
}
