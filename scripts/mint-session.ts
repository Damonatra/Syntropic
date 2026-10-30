/**
 * Mint an enclave session cookie for browser verification — the exact HMAC
 * the server's session.ts validates, computed from the local .env secret.
 * Usage: npx tsx scripts/mint-session.ts <username>
 * Prints `enclave_session=<value>` for curl/agent-browser use.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const username = process.argv[2];
if (!username) {
  console.error("usage: tsx scripts/mint-session.ts <username>");
  process.exit(1);
}

const env = readFileSync(".env", "utf8");
const line = env.split("\n").find((l) => l.startsWith("ENCLAVE_SESSION_SECRET="));
if (!line) {
  console.error("ENCLAVE_SESSION_SECRET not configured in .env");
  process.exit(1);
}
const secret = line.slice("ENCLAVE_SESSION_SECRET=".length).trim();

const sig = createHmac("sha256", secret).update(`vertebra-operator-v1:${username}`).digest("hex");
console.log(`enclave_session=${username}.${sig}`);
