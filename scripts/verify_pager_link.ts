/**
 * Pager link verification — the end-to-end proof.
 *
 * 1. Ledger: arm slack-pager (its incoming webhook arrived in chat),
 *    refresh the telegram note (chat id now captured), report rows.
 * 2. Wire: fire ONE real page through deliverAlert — the exact send path
 *    every pager consumer shares (reply pager, convoy, ingest, escalations) —
 *    which walks env → registry gate → HTTP for both channels.
 *
 * Exits non-zero if either channel fails. Key VALUES never print.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function ledger() {
  await db.integrationRecord.upsert({
    where: { provider: "slack-pager" },
    create: { provider: "slack-pager", kind: "pager", authType: "api_key", keyEnvVar: "SLACK_WEBHOOK_URL", notes: "Slack — pager" },
    update: {},
  });
  await db.integrationRecord.upsert({
    where: { provider: "telegram-pager" },
    create: { provider: "telegram-pager", kind: "pager", authType: "api_key", keyEnvVar: "TELEGRAM_BOT_TOKEN", notes: "Telegram — pager" },
    update: {},
  });
  await db.integrationRecord.update({
    where: { provider: "slack-pager" },
    data: { status: "armed", notes: "armed by operator instruction — incoming webhook supplied in chat, 2026-10-31" },
  });
  await db.integrationRecord.update({
    where: { provider: "telegram-pager" },
    data: { status: "armed", notes: "armed by operator instruction — token + chat id captured and verified, 2026-10-31" },
  });
  const rows = await db.integrationRecord.findMany({
    where: { provider: { in: ["slack-pager", "telegram-pager"] } },
    select: { provider: true, status: true, keyEnvVar: true },
  });
  for (const r of rows) console.log(`${r.provider.padEnd(16)} ${r.status.padEnd(6)} key=${r.keyEnvVar}`);
}

async function wire() {
  const { deliverAlert } = await import("../src/lib/vertebra/pager");
  const out = await deliverAlert(
    "PAGER LINK VERIFIED · Vertebra",
    "This was the live end-to-end proof: the enclave's own send path (env → registry gate → provider) just reached both channels. Live-intent replies, convoy touches, and crit escalations arrive exactly like this.",
  );
  console.log("attempted:", out.attempted.join(",") || "none");
  console.log("delivered:", out.delivered.join(",") || "none");
  if (out.refused.length) console.log("refused:", out.refused.join(" | "));
  if (out.delivered.length < 2) process.exitCode = 1;
}

ledger()
  .then(wire)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
