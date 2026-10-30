/**
 * Generate one strong hand-delivered operator password on stdout.
 *
 * 18 chars over a 56-symbol lookalike-free alphabet (no I O l o 0 1) with
 * rejection sampling — uniform, ~104 bits. Nothing is persisted: the plaintext
 * exists only in the caller's shell variable and the one-time chat handover.
 * Pair with seed-operators:
 *   JOSIAS_PASSWORD="$(npx tsx scripts/gen-password.ts)" npx tsx scripts/seed-operators.ts
 */
import { randomBytes } from "node:crypto";

const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // 56 symbols
const LEN = 18;

let out = "";
while (out.length < LEN) {
  for (const b of randomBytes(32)) {
    if (b >= 224) continue; // 224 = 4 × 56 — rejection keeps the draw uniform
    out += ALPHA[b % 56];
    if (out.length === LEN) break;
  }
}
process.stdout.write(out);
