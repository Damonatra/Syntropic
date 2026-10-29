import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const counts = {
    prospects: await db.prospect.count(),
    contacts: await db.contact.count(),
    scores: await db.score.count(),
    dispatches: await db.dispatch.count(),
    outbox: await db.outboxEvent.count(),
    highTouch: await db.highTouchQueueItem.count(),
    clusters: await db.leadCluster.count(),
    telemetry: await db.telemetryEvent.count(),
    alerts: await db.intentAlert.count(),
    replies: await db.inboundReply.count(),
    drafts: await db.agentDraft.count(),
  };
  console.log(JSON.stringify(counts, null, 2));
  const clusters = await db.leadCluster.findMany({ select: { clusterName: true, densityCount: true, anchorCity: true } });
  console.log(JSON.stringify(clusters, null, 2));
  const top = await db.prospect.findMany({
    where: { scores: { some: {} } },
    include: { scores: true, cluster: true },
    take: 5,
    orderBy: { createdAt: "asc" },
  });
  console.log(top.map(t => `${t.name} | ${t.vertical} | ${t.city}, ${t.stateProvince} | score=${t.scores[0]?.qlvScore} | erp=${t.detectedErp} | portal=${t.quotePortalType} | lat=${t.latitude} lng=${t.longitude} | cluster=${t.clusterId} | audit=${t.auditImageUrl ? "yes" : "no"}`).join("\n"));
  const withTelemetry = await db.telemetryEvent.findMany({ take: 5, orderBy: { occurredAt: "desc" }, include: { prospect: { select: { name: true } } } });
  console.log("TELEMETRY:", withTelemetry.map(t => `${t.occurredAt.toISOString()} ${t.eventType} ${t.prospect?.name ?? "?"} ${t.city ?? ""}`).join(" || "));
}
main().finally(() => db.$disconnect());
