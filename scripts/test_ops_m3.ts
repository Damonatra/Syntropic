/**
 * M3 verification — flap memory, ack reasons, watch self-audit.
 *
 * Part 1 (pure): deriveFlapAlerts thresholds and self-exclusion.
 * Part 2 (live): writes real rows into the OpsWatchFire / OpsAlertAck
 * ledgers, reads the real /api/command snapshot, asserts the flap alarm and
 * the ack-accuracy strip, then DELETES the test rows — the ledger is left
 * exactly as it was found.
 *
 *   bun scripts/test_ops_m3.ts
 */
import { PrismaClient } from "@prisma/client";
import { deriveFlapAlerts, FLAP_HOURS_24H } from "../src/lib/vertebra/watches";

const db = new PrismaClient();
let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const HOUR = 3_600_000;

// --------------------------------------------------------------------------- //
// Part 1 — flap watch (pure)
// --------------------------------------------------------------------------- //
console.log("deriveFlapAlerts — the watchtower watching itself");

{
  const alerts = deriveFlapAlerts(
    [
      { watchKey: "test_chronic:system", fires24h: 14 },
      { watchKey: "healthy_watch:system", fires24h: 3 },
      { watchKey: "watch_flap:test_chronic", fires24h: 20 }, // meta — must exclude itself
    ],
    NOW,
  );
  check("chronic watch (≥12/24) rings the self-audit", alerts.length === 1 && alerts[0].watchId === "watch_flap", JSON.stringify(alerts.map((a) => a.title)));
  check("subject names the chronic watch", alerts[0]?.subjectLabel === "test_chronic");
  check("info severity — meta alarm, not a crisis", alerts[0]?.severity === "info");
  check("evidence carries the occupancy math", Boolean(alerts[0]?.evidence?.includes("14/24")));
  check("meta watch never flags itself", !alerts.some((a) => a.title.includes("watch_flap")));
  check("threshold constant is half a day", FLAP_HOURS_24H === 12);
}

{
  const alerts = deriveFlapAlerts([{ watchKey: "edge:system", fires24h: 11 }], NOW);
  check("watch below the threshold stays quiet", alerts.length === 0);
}

// --------------------------------------------------------------------------- //
// Part 2 — live end-to-end through the real snapshot route
// --------------------------------------------------------------------------- //
console.log("live: fire ledger + ack accuracy through /api/command");

const TEST_KEY = "test_chronic:system";
const HEALTH_WATCH = "test_health";

async function main() {
  const realNow = Date.now();
  const hourBucket = Math.floor(realNow / HOUR);
  // Simulate a condition live in 14 distinct hourly sweeps (including now).
  await db.$executeRawUnsafe(`DELETE FROM OpsWatchFire WHERE watchKey = ?`, TEST_KEY);
  for (let i = 0; i < 14; i++) {
    await db.$executeRawUnsafe(
      `INSERT INTO OpsWatchFire (id, watchKey, hourBucket, lastFireAt) VALUES (?, ?, ?, ?)
       ON CONFLICT(watchKey, hourBucket) DO NOTHING`,
      `m3test_fire_${i}`,
      TEST_KEY,
      hourBucket - i,
      new Date(realNow - i * HOUR),
    );
  }
  // Three ack verdicts for test_health: 2 real, 1 false positive.
  await db.$executeRawUnsafe(`DELETE FROM OpsAlertAck WHERE alertKey LIKE ?`, `${HEALTH_WATCH}:%`);
  const verdicts = ["real", "real", "false_positive"];
  for (let i = 0; i < verdicts.length; i++) {
    await db.$executeRawUnsafe(
      `INSERT INTO OpsAlertAck (id, alertKey, actor, reason, createdAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(alertKey) DO NOTHING`,
      `m3test_ack_${i}`,
      `${HEALTH_WATCH}:subj${i}:99999${i}`,
      "operator",
      verdicts[i],
      new Date(realNow - i * HOUR),
    );
  }

  // Read the live snapshot (gate cookie computed the same way the console
  // does). The command route serves a 5s in-memory snapshot cache kept warm
  // by the open console — wait it out so this fetch forces a fresh build.
  await new Promise((r) => setTimeout(r, 5_500));
  const user = process.env.OPERATOR_USER ?? "josias";
  const pass = process.env.OPERATOR_PASSWORD;
  if (!pass) {
    console.error("set OPERATOR_PASSWORD — the shared enclave password is retired");
    process.exit(1);
  }
  const login = await fetch("http://localhost:3000/api/gate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password: pass }),
  });
  check("gate login", login.ok, `status ${login.status}`);
  const cookie = /enclave_session=([^;]*)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
  const res = await fetch("http://localhost:3000/api/command", { headers: { cookie: `enclave_session=${cookie}` } });
  check("command snapshot reads", res.ok, `status ${res.status}`);
  const snap = (await res.json()) as {
    ops: {
      deck: Array<{ watchId: string; subjectLabel: string; evidence: string | null; fires24h?: number }>;
      watchHealth?: Array<{ watchId: string; acked7d: number; realSharePct: number | null; falsePositive7d: number }>;
    };
  };

  const flap = snap.ops.deck.find((a) => a.watchId === "watch_flap");
  check("flap alarm live on the real deck", Boolean(flap), JSON.stringify(snap.ops.deck.map((a) => a.watchId)));
  check("flap alarm names the chronic test watch", flap?.subjectLabel === "test_chronic");
  check("flap alarm carries occupancy math", Boolean(flap?.evidence?.includes("14/24")));

  const health = snap.ops.watchHealth?.find((w) => w.watchId === HEALTH_WATCH);
  check("ack accuracy strip carries the test watch", Boolean(health), JSON.stringify(snap.ops.watchHealth));
  check("verdicts tallied honestly (2 real / 1 fp → 66%)", health?.acked7d === 3 && health?.realSharePct === 67 && health?.falsePositive7d === 1, JSON.stringify(health));

  // Cleanup — leave the ledgers exactly as found.
  const delFire = await db.$executeRawUnsafe(`DELETE FROM OpsWatchFire WHERE watchKey = ?`, TEST_KEY);
  const delAck = await db.$executeRawUnsafe(`DELETE FROM OpsAlertAck WHERE alertKey LIKE ?`, `${HEALTH_WATCH}:%`);
  console.log(`  cleaned up — ${delFire} fire rows, ${delAck} ack rows removed`);
}

await main();
await db.$disconnect();
console.log(failures === 0 ? "\nall M3 checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
