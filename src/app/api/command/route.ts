/**
 * GET /api/command — aggregate read model for the Executive Enclave.
 * One round-trip: leads + live feed + triage + alerts + clusters + funnel + ops.
 * Served through a short in-memory window (5s) with ETag revalidation — the
 * console polls every 60s and the bridge scrapes leads, so identical
 * snapshots return 304 instead of re-serializing the whole read model.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCachedSnapshot, storeSnapshot } from "@/lib/vertebra/snapshot-cache";
import { deriveKpiInputs } from "@/lib/vertebra/persona";
import {
  annualLeakageUsd,
  effectivePriority,
  isHighSignal,
  type AlertItem,
  type ClusterShape,
  type CommandLead,
  type CommandSnapshot,
  type ErpShape,
  type FeedItem,
  type FunnelStage,
  type KpiInputs,
  type OpsModule,
  type OpsSnapshot,
  type ReplyIntent,
  type ScoreShape,
  type TriageItem,
} from "@/lib/vertebra/command";

function parseErp(raw: string | null): ErpShape | null {
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as Partial<ErpShape>;
    if (!doc.detected_erp) return null;
    return {
      detected_erp: doc.detected_erp,
      erp_family: doc.erp_family ?? null,
      quote_portal_type: doc.quote_portal_type ?? "undetermined",
      job_signal_count: doc.job_signal_count ?? 0,
      recommended_pitch_angle: doc.recommended_pitch_angle ?? "",
      evidence: doc.evidence ?? {},
      profiled_at: doc.profiled_at ?? null,
    };
  } catch {
    return null;
  }
}

function parseScore(
  row:
    | {
        qlvScore: number;
        band: string;
        factorsJson: string;
        hooksJson: string;
        rationale: string;
        model: string;
        createdAt: Date;
      }
    | undefined,
): ScoreShape | null {
  if (!row) return null;
  try {
    return {
      qlvScore: row.qlvScore,
      band: row.band,
      factors: JSON.parse(row.factorsJson),
      hooks: JSON.parse(row.hooksJson),
      rationale: row.rationale,
      model: row.model,
      createdAt: row.createdAt.toISOString(),
    };
  } catch {
    return null;
  }
}

const SNOOZE_RE = /snooze:(\d+)h/;

export async function GET(request: Request) {
  const ifNoneMatch = request.headers.get("if-none-match");
  const cached = getCachedSnapshot(ifNoneMatch);
  if (cached.status === 304 && cached.etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: cached.etag } });
  }
  if (cached.body) {
    return new NextResponse(cached.body, {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: cached.etag ?? "" },
    });
  }
  try {
    const now = Date.now();
    const dayAgo = new Date(now - 86_400_000);

    const prospects = await db.prospect.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        contacts: { take: 1 },
        scores: { orderBy: { createdAt: "desc" }, take: 1 },
        dispatches: { orderBy: { createdAt: "asc" } },
        highTouch: true,
        cluster: true,
        operatorActions: { orderBy: { createdAt: "desc" }, take: 5 },
      },
    });

    const telemetryRows = await db.telemetryEvent.findMany({
      where: { occurredAt: { gte: new Date(now - 86_400_000 * 7) } },
      orderBy: { occurredAt: "desc" },
      take: 800,
    });

    const alertsRows = await db.intentAlert.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { prospect: { select: { id: true, name: true } } },
    });

    const replies = await db.inboundReply.findMany({
      orderBy: { receivedAt: "desc" },
      take: 40,
      include: {
        prospect: { select: { id: true, name: true, scores: { take: 1, orderBy: { createdAt: "desc" } } } },
        drafts: { orderBy: { createdAt: "desc" } },
      },
    });

    const outboxPending = await db.outboxEvent.count({ where: { publishedAt: null } });
    const outboxPublished = await db.outboxEvent.count({ where: { publishedAt: { not: null } } });

    // ---- telemetry aggregation per prospect ------------------------------- //
    const teleMap = new Map<
      string,
      {
        lastEventType: string | null;
        lastEventAtMs: number | null;
        lastHighSignalAtMs: number | null;
        events48h: number;
        totalSessionMs: number;
      }
    >();
    for (const e of telemetryRows) {
      if (!e.prospectId) continue;
      const cur = teleMap.get(e.prospectId) ?? {
        lastEventType: null,
        lastEventAtMs: null,
        lastHighSignalAtMs: null,
        events48h: 0,
        totalSessionMs: 0,
      };
      if (cur.lastEventAtMs == null) {
        cur.lastEventType = e.eventType;
        cur.lastEventAtMs = e.occurredAt.getTime();
      }
      if (cur.lastHighSignalAtMs == null && isHighSignal(e.eventType)) cur.lastHighSignalAtMs = e.occurredAt.getTime();
      if (e.occurredAt.getTime() >= now - 86_400_000 * 2) cur.events48h += 1;
      cur.totalSessionMs += e.durationMs ?? 0;
      teleMap.set(e.prospectId, cur);
    }

    // ---- leads ------------------------------------------------------------ //
    type LeadInternal = CommandLead & { __deferred: boolean; __called: boolean };
    const leads: LeadInternal[] = prospects
      .filter((p) => p.ingestion !== "filtered")
      .map((p) => {
        const score = parseScore(p.scores[0]);
        const tele = teleMap.get(p.id) ?? {
          lastEventType: null,
          lastEventAtMs: null,
          lastHighSignalAtMs: null,
          events48h: 0,
          totalSessionMs: 0,
        };
        const dispatchRows = p.dispatches.filter((d) => d.status !== "suppressed");
        const lastDispatch = dispatchRows[dispatchRows.length - 1];
        const lastAction = p.operatorActions[0] ?? null;
        let snoozedUntilMs: number | null = null;
        for (const a of p.operatorActions) {
          if (a.action !== "snoozed") continue;
          const hours = Number(a.note?.match(SNOOZE_RE)?.[1] ?? 24);
          const until = a.createdAt.getTime() + hours * 3_600_000;
          if (until > now) snoozedUntilMs = until;
          break;
        }
        const deferred =
          lastAction?.action === "deferred" &&
          (tele.lastHighSignalAtMs == null || tele.lastHighSignalAtMs < lastAction.createdAt.getTime());
        const priority =
          effectivePriority(
            {
              qlvScore: score?.qlvScore ?? null,
              lastHighSignalAtMs: tele.lastHighSignalAtMs,
              lastEventType: tele.lastEventType,
            },
            now,
          ) * (lastAction?.action === "called" ? 0.5 : 1);
        const highIntentNow =
          tele.lastHighSignalAtMs != null && score != null && score.qlvScore >= 85 && now - tele.lastHighSignalAtMs <= 15 * 60_000;
        return {
          id: p.id,
          name: p.name,
          domain: p.domain,
          vertical: p.vertical,
          city: p.city,
          stateProvince: p.stateProvince,
          country: p.country,
          region: p.region,
          revenueEstimateUsd: p.revenueEstimateUsd,
          employeeCount: p.employeeCount,
          ingestion: p.ingestion,
          caslScope: p.caslScope,
          bestEmail: p.bestEmail,
          contact: p.contacts[0]
            ? {
                name: `${p.contacts[0].firstName} ${p.contacts[0].lastName}`,
                role: p.contacts[0].role,
                titleRaw: p.contacts[0].titleRaw ?? p.contacts[0].role,
                phone: p.contacts[0].phone,
              }
            : null,
          score,
          erp: parseErp(p.erpMetadata),
          quotePortalType: p.quotePortalType,
          auditImageUrl: p.auditImageUrl,
          latitude: p.latitude,
          longitude: p.longitude,
          clusterId: p.clusterId,
          clusterName: p.cluster?.clusterName ?? null,
          lastIntentHeat: p.lastIntentHeat,
          telemetry: tele,
          dispatch: lastDispatch
            ? {
                channel: lastDispatch.channel,
                status: lastDispatch.status,
                scheduledAtMs: lastDispatch.scheduledAt?.getTime() ?? null,
                steps: dispatchRows.length,
              }
            : null,
          highTouch: p.highTouch
            ? { qlvScore: p.highTouch.qlvScore, exportedAtMs: p.highTouch.exportedAt?.getTime() ?? null }
            : null,
          leakageUsd: annualLeakageUsd(p.revenueEstimateUsd, score?.qlvScore ?? null),
          priority,
          highIntentNow,
          pendingDrafts: 0,
          snoozedUntilMs,
          lastActionAtMs: lastAction?.createdAt.getTime() ?? null,
          __deferred: deferred,
          __called: lastAction?.action === "called",
        };
      });

    const pendingDraftCounts = new Map<string, number>();
    for (const r of replies) {
      const pending = r.drafts.filter((d) => d.status === "pending_human_review").length;
      if (pending > 0 && r.prospectId) pendingDraftCounts.set(r.prospectId, pending);
    }
    for (const lead of leads) lead.pendingDrafts = pendingDraftCounts.get(lead.id) ?? 0;

    // ---- feed ------------------------------------------------------------- //
    const nameById = new Map(prospects.map((p) => [p.id, p]));
    const feed: FeedItem[] = telemetryRows.slice(0, 40).map((e) => {
      const p = e.prospectId ? nameById.get(e.prospectId) : undefined;
      return {
        id: e.id,
        prospectId: e.prospectId,
        prospectName: p?.name ?? "Unknown",
        qlvScore: p?.scores[0]?.qlvScore ?? null,
        clusterName: p?.cluster?.clusterName ?? null,
        vertical: p?.vertical ?? null,
        eventType: e.eventType,
        url: e.url,
        city: e.city,
        country: e.country,
        device: e.device,
        durationMs: e.durationMs,
        occurredAtMs: e.occurredAt.getTime(),
        alertFired:
          p != null &&
          isHighSignal(e.eventType) &&
          (p.scores[0]?.qlvScore ?? 0) >= 85 &&
          now - e.occurredAt.getTime() <= 3_600_000,
      };
    });

    // ---- triage ----------------------------------------------------------- //
    const triageMap = (r: (typeof replies)[number]): TriageItem => {
      const draft = r.drafts[0] ?? null;
      const rescheduled = r.extractedJson
        ? (JSON.parse(r.extractedJson).return_date as string | undefined)
        : undefined;
      return {
        draftId: draft?.id ?? null,
        replyId: r.id,
        prospectId: r.prospect?.id ?? "",
        prospectName: r.prospect?.name ?? "Unknown",
        qlvScore: r.prospect?.scores[0]?.qlvScore ?? null,
        intent: r.intent as ReplyIntent,
        confidence: r.intentConfidence,
        fromEmail: r.fromEmail,
        subject: r.subject ?? "",
        body: r.body,
        draftSubject: draft?.subject ?? null,
        draftBody: draft?.body ?? null,
        draftStatus: draft?.status ?? null,
        receivedAtMs: r.receivedAt.getTime(),
        rationale: r.rationale,
        rescheduledToMs: rescheduled ? new Date(rescheduled).getTime() : null,
      };
    };
    const triage = {
      pending: replies.filter((r) => r.drafts.some((d) => d.status === "pending_human_review")).map(triageMap),
      auto: replies
        .filter(
          (r) =>
            r.drafts.some((d) => d.status === "sent") ||
            ["out_of_office", "not_interested"].includes(r.intent),
        )
        .map(triageMap),
      closed: replies
        .filter((r) => r.drafts.some((d) => d.status === "approved" || d.status === "discarded"))
        .map(triageMap),
    };

    // ---- alerts ----------------------------------------------------------- //
    const alerts: AlertItem[] = alertsRows.map((a) => ({
      id: a.id,
      prospectId: a.prospectId,
      prospectName: a.prospect?.name ?? "Unknown",
      title: a.title,
      body: a.body,
      acknowledgedAtMs: a.acknowledgedAt?.getTime() ?? null,
      createdAtMs: a.createdAt.getTime(),
    }));

    // ---- clusters --------------------------------------------------------- //
    const clusters: ClusterShape[] = [];
    for (const p of prospects) {
      if (!p.cluster) continue;
      let c = clusters.find((x) => x.id === p.cluster!.id);
      if (!c) {
        c = {
          id: p.cluster.id,
          clusterKey: p.cluster.clusterKey,
          clusterName: p.cluster.clusterName,
          anchorCity: p.cluster.anchorCity,
          anchorCountry: p.cluster.anchorCountry,
          centroidLat: p.cluster.centroidLat,
          centroidLng: p.cluster.centroidLng,
          radiusM: p.cluster.radiusM,
          densityCount: p.cluster.densityCount,
          verticalFocus: p.cluster.verticalFocus,
          memberIds: [],
          leakageUsd: 0,
          hotCount: 0,
        };
        clusters.push(c);
      }
      c.memberIds.push(p.id);
      c.leakageUsd += leads.find((l) => l.id === p.id)?.leakageUsd ?? 0;
      if ((p.scores[0]?.qlvScore ?? 0) >= 85) c.hotCount += 1;
    }

    // ---- funnel ----------------------------------------------------------- //
    const engaged = (l: CommandLead) =>
      l.telemetry.lastEventAtMs != null && now - l.telemetry.lastEventAtMs < 7 * 86_400_000;
    const stageDef: Array<{ stage: string; label: string; match: (l: CommandLead) => boolean }> = [
      { stage: "ingested", label: "Ingested", match: () => true },
      { stage: "verified", label: "Verified", match: (l) => Boolean(l.bestEmail) },
      { stage: "scored", label: "Scored", match: (l) => l.score != null },
      { stage: "enriched", label: "ERP-Profiled", match: (l) => l.erp != null },
      { stage: "dispatched", label: "Dispatched", match: (l) => Boolean(l.dispatch || l.highTouch) },
      { stage: "engaged", label: "Engaged", match: engaged },
      { stage: "high_touch", label: "High-Touch", match: (l) => Boolean(l.highTouch) },
    ];
    const funnel: FunnelStage[] = stageDef.map((s) => {
      const members = leads.filter(s.match);
      return {
        stage: s.stage,
        label: s.label,
        count: members.length,
        leakageUsd: members.reduce((sum, l) => sum + (l.leakageUsd ?? 0), 0),
      };
    });

    // ---- ops -------------------------------------------------------------- //
    const telemetry24h = telemetryRows.filter((e) => e.occurredAt >= dayAgo).length;
    const dispatch24h = await db.dispatch.count({
      where: { updatedAt: { gte: dayAgo }, status: { in: ["sent", "opened", "clicked"] } },
    });
    const channelACount = await db.dispatch.count({ where: { channel: "channel_a_automated_email" } });
    const channelBCount = await db.highTouchQueueItem.count();
    const verifiedEmails = leads.filter((l) => l.bestEmail).length;
    const modules: OpsModule[] = [
      { id: "m1", module: "M1 · Ingestion", enginePath: "vertebra/ingestion/scraper.py", status: "ok", detail: "Six directories wired; corridor filter enforced." },
      { id: "m2", module: "M2 · Permutations", enginePath: "vertebra/enrichment/permutations.py", status: verifiedEmails > 0 ? "ok" : "warn", detail: `${verifiedEmails}/${leads.length} prospects carry a verified best-email.` },
      { id: "m3", module: "M3 · QLV Scorer", enginePath: "vertebra/ai/scorer.py", status: "ok", detail: `${scoredLeadsCount(leads)} scored · ${critCount(leads)} in critical band.` },
      { id: "m4", module: "M4 · Dispatch Router", enginePath: "vertebra/dispatch/router.py", status: outboxPending > 0 ? "warn" : "ok", detail: `Channel A ${channelACount} rows · Channel B ${channelBCount} queued · ${outboxPending} outbox pending.` },
      { id: "m5", module: "M5 · ERP Profiler", enginePath: "vertebra/enrichment/erp_profiler.py", status: "ok", detail: `${leads.filter((l) => l.erp != null).length} profiles with pitch angles.` },
      { id: "m6", module: "M6 · Audit Preview", enginePath: "vertebra/intelligence/audit_preview.py", status: "warn", detail: "Playwright CDN offload disabled in sandbox — widget renders natively in dossiers." },
      { id: "m7", module: "M7 · Spatial Clustering", enginePath: "vertebra/spatial/clustering.py", status: "ok", detail: `${clusters.length} theatres active.` },
      { id: "m8", module: "M8 · Intent Tracker", enginePath: "vertebra/telemetry/intent_tracker.py", status: "ok", detail: `${telemetry24h} events / 24h · ${alerts.filter((a) => a.createdAtMs >= dayAgo.getTime()).length} alerts fired.` },
      { id: "m9", module: "M9 · Reply Agent", enginePath: "vertebra/ai/reply_agent.py", status: "ok", detail: `${triage.pending.length} drafts pending review · ${triage.auto.length} auto-resolved.` },
    ];
    const ops: OpsSnapshot = {
      modules,
      outboxPending,
      outboxPublished,
      dispatchesSent24h: dispatch24h,
      telemetryEvents24h: telemetry24h,
      alerts24h: alerts.filter((a) => a.createdAtMs >= dayAgo.getTime()).length,
      verifiedEmailShare: leads.length ? Math.round((verifiedEmails / leads.length) * 100) : 0,
      channelACount,
      channelBCount,
    };

    const snapshot: CommandSnapshot = {
      generatedAtMs: now,
      leads,
      feed,
      triage,
      alerts,
      clusters,
      funnel,
      ops,
      baseline: null,
    };

    // ---- 24h baseline ledger ------------------------------------------------ //
    // Hourly capture of the raw KPI inputs; the delta comparison point is the
    // newest capture older than 24h. Raw SQL on purpose: the ledger must not
    // depend on the Prisma Client generation inside the running process — a
    // schema push plus regenerate never requires a server restart. Ledger
    // failures must never break the read path: deltas simply disappear.
    try {
      const inputs = deriveKpiInputs(snapshot);
      type BaselineRow = { id: string; capturedAt: Date; metricsJson: string };
      const lastRows = await db.$queryRawUnsafe<BaselineRow[]>(
        `SELECT id, capturedAt, metricsJson FROM CommandBaseline ORDER BY capturedAt DESC LIMIT 1`,
      );
      const last = lastRows[0];
      if (!last || now - new Date(last.capturedAt).getTime() >= 3_600_000) {
        await db.$executeRawUnsafe(
          `INSERT INTO CommandBaseline (id, capturedAt, metricsJson) VALUES (?, ?, ?)`,
          `cb_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          new Date(now),
          JSON.stringify(inputs),
        );
        await db.$executeRawUnsafe(`DELETE FROM CommandBaseline WHERE capturedAt < ?`, new Date(now - 7 * 86_400_000));
      }
      const baseRows = await db.$queryRawUnsafe<BaselineRow[]>(
        `SELECT id, capturedAt, metricsJson FROM CommandBaseline WHERE capturedAt <= ? ORDER BY capturedAt DESC LIMIT 1`,
        new Date(now - 86_400_000),
      );
      const fallbackRows = await db.$queryRawUnsafe<BaselineRow[]>(
        `SELECT id, capturedAt, metricsJson FROM CommandBaseline WHERE capturedAt < ? ORDER BY capturedAt ASC LIMIT 1`,
        new Date(now - 60_000),
      );
      const baseRow = baseRows[0] ?? fallbackRows[0];
      if (baseRow) {
        const EMPTY_INPUTS: KpiInputs = {
          leakageTotalUsd: 0,
          criticalCount: 0,
          draftsPending: 0,
          scoredCount: 0,
          latencyCrew: 0,
          spaLaggards: 0,
          manualAvg: 0,
          highIntentCount: 0,
          telemetryEvents24h: 0,
          dispatchesSent24h: 0,
        };
        const parsed = { ...EMPTY_INPUTS, ...(JSON.parse(baseRow.metricsJson) as Partial<KpiInputs>) } as KpiInputs;
        snapshot.baseline = { capturedAtMs: new Date(baseRow.capturedAt).getTime(), inputs: parsed };
      }
    } catch (err) {
      console.error("[api/command] baseline ledger failed", err);
    }

    const body = JSON.stringify(snapshot);
    const etag = storeSnapshot(body);
    return new NextResponse(body, {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: etag },
    });
  } catch (error) {
    console.error("[api/command] failed", error);
    return NextResponse.json({ error: "command snapshot failed" }, { status: 500 });
  }
}

function scoredLeadsCount(leads: CommandLead[]): number {
  return leads.filter((l) => l.score != null).length;
}
function critCount(leads: CommandLead[]): number {
  return leads.filter((l) => (l.score?.qlvScore ?? 0) >= 85).length;
}

export const dynamic = "force-dynamic";
