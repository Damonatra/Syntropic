/**
 * Seed + arm the pager rows in the dev ledger — the operator's credentials
 * arrived in chat and the instruction was "proceed", so this IS the
 * deliberate arming act, recorded with a note naming its cause.
 *
 *   - telegram-pager → armed (token live; chat id pending, gate still
 *     skips honestly until TELEGRAM_CHAT_ID is set)
 *   - slack-pager → stays staged (the pasted token is a rotating user
 *     token, not the incoming webhook URL the pager consumes)
 *
 * Prints status only — key VALUES never cross this script's output.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const NOTE = "armed by operator instruction — credentials supplied in chat, 2026-10-31";

async function main() {
  // seed both pager rows if absent (same star map the panel seeds on GET)
  for (const p of [
    { provider: "slack-pager", keyEnvVar: "SLACK_WEBHOOK_URL", label: "Slack — pager" },
    { provider: "telegram-pager", keyEnvVar: "TELEGRAM_BOT_TOKEN", label: "Telegram — pager" },
  ]) {
    await db.integrationRecord.upsert({
      where: { provider: p.provider },
      create: { provider: p.provider, kind: "pager", authType: "api_key", keyEnvVar: p.keyEnvVar, notes: `${p.label} (seeded by arm_pager)` },
      update: {},
    });
  }

  const tg = await db.integrationRecord.update({
    where: { provider: "telegram-pager" },
    data: { status: "armed", notes: NOTE },
  });

  const slack = await db.integrationRecord.findUnique({ where: { provider: "slack-pager" } });

  const present = (v: string | null | undefined) =>
    typeof process.env[v ?? ""] === "string" && (process.env[v ?? ""] ?? "").length >= 8;

  console.log("telegram-pager:", tg.status, "| key", tg.keyEnvVar, "present:", present(tg.keyEnvVar));
  console.log("slack-pager:  ", slack?.status, "| key", slack?.keyEnvVar, "present:", present(slack?.keyEnvVar));
  console.log("TELEGRAM_CHAT_ID present:", present("TELEGRAM_CHAT_ID"), "(gate stays honest until it lands)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
