/**
 * Reply-pager probe — POSTs one fresh "interested" reply through the real
 * ingest path (replies.ts: classify → tiered autonomy → pager), verifies the
 * pager claim pulse + parked draft, then REMOVES the probe rows so the dummy
 * cast keeps its story.
 *
 *   bun run scripts/dummy_reply_probe.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const silo = await db.prospect.findFirst({ where: { domainKey: "dummy-silobridge" }, select: { id: true, name: true, bestEmail: true } });
if (!silo) throw new Error("dummy-silobridge not found — seed first");

const { ingestReply } = await import("@/lib/vertebra/replies");
const result = await ingestReply({
  prospectId: silo.id,
  fromEmail: silo.bestEmail!,
  subject: "Re: Silo Bridge Conveyance: RFQ turnaround",
  body: "Following up on my last note — we'd be interested in a call. What does onboarding look like?",
});

if (!result.ok) throw new Error(`ingest failed: ${JSON.stringify(result)}`);
console.log(`intent=${result.intent} · confidence=${result.confidence.toFixed(2)} · tier=${result.tier} · action=${result.action}`);
console.log(`draft: ${result.draft ? `${result.draft.status} — "${result.draft.subject}"` : "none"}`);

const pulse = await db.enginePulse.findFirst({ where: { engineId: "reply-pager", pulseRef: `page:${result.replyId}` } });
console.log(`pager claim pulse: ${pulse ? "WRITTEN (reply-pager · page:<replyId>)" : "MISSING"}`);
const delivered = pulse ? "no live Telegram/Slack channels configured — page landed as an Ops pulse row (honest)" : "";
if (delivered) console.log(delivered);

// restore the cast: take the probe's evidence back out
await db.agentDraft.deleteMany({ where: { replyId: result.replyId } });
await db.inboundReply.delete({ where: { id: result.replyId } });
await db.enginePulse.deleteMany({ where: { engineId: "reply-pager", pulseRef: `page:${result.replyId}` } });
console.log(`probe rows removed — cast restored\n`);

await db.$disconnect();
