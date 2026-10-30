/**
 * Signed-door proof — acts as an external engine:
 *   1. reads OPS_HEARTBEAT_SECRET from .env
 *   2. HMAC-signs a pulse body
 *   3. POSTs to /api/ops/heartbeat
 *   4. asserts dedup on retry (same pulseRef twice)
 *   5. asserts 401 on an unsigned request
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const env = readFileSync(".env", "utf8");
const secret = env.match(/^OPS_HEARTBEAT_SECRET=(.+)$/m)?.[1]?.trim();
if (!secret) throw new Error("OPS_HEARTBEAT_SECRET not found in .env");

const base = process.env.BASE_URL ?? "http://localhost:3000";
const pulseRef = `door-proof-${Date.now().toString(36)}`;
const body = JSON.stringify({
  engineId: "door-proof-engine",
  pulseRef,
  watchId: "door_proof",
  status: "ok",
  detail: "signed door verification pulse — safe to ignore",
  expectEveryMs: 300_000,
});

const sig = createHmac("sha256", secret).update(body).digest("hex");

async function main() {
  // 1. unsigned → expect 401
  const unsigned = await fetch(`${base}/api/ops/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  console.log(`unsigned POST -> ${unsigned.status} (expect 401)`);

  // 2. signed → expect 200 { ok: true, deduped: false }
  const signed = await fetch(`${base}/api/ops/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-vertebra-signature": `sha256=${sig}` },
    body,
  });
  const signedJson = (await signed.json()) as Record<string, unknown>;
  console.log(`signed POST   -> ${signed.status} ${JSON.stringify(signedJson)} (expect 200, deduped:false)`);

  // 3. same pulseRef again → expect 200 { deduped: true }
  const retry = await fetch(`${base}/api/ops/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-vertebra-signature": `sha256=${sig}` },
    body,
  });
  const retryJson = (await retry.json()) as Record<string, unknown>;
  console.log(`retry POST    -> ${retry.status} ${JSON.stringify(retryJson)} (expect 200, deduped:true)`);

  const ok =
    unsigned.status === 401 &&
    signed.status === 200 &&
    signedJson.deduped === false &&
    retry.status === 200 &&
    retryJson.deduped === true;
  console.log(ok ? "\nDOOR PROOF: PASS" : "\nDOOR PROOF: FAIL");
  process.exit(ok ? 0 : 1);
}

main();
