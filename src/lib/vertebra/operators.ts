/**
 * Operator credentials — scrypt hashing and verification.
 *
 * The enclave door is identity now: each operator has a row in the Operator
 * table and their password exists ONLY as a salted scrypt hash. This module
 * is the single place that touches password material, so the contract stays
 * auditable in one file:
 *
 *   stored format: scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
 *
 * node:crypto scrypt — no new dependency, works offline (enclave posture:
 * zero external calls). Verification is timing-safe via timingSafeEqual.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

function scryptAsync(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/** scrypt cost — OWASP-aligned for interactive login (N=2^15, r=8, p=1). */
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
/** 128·N·r is exactly Node's 32MB default maxmem — grant explicit headroom. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Minimum accepted operator password length — weaker locks are refused loudly. */
export const OPERATOR_MIN_PASSWORD_LENGTH = 12;

/** Hash a plaintext password into the stored scrypt envelope. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Verify a candidate against a stored envelope — timing-safe, false on any malformation. */
export async function verifyPassword(candidate: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    const hash = await scryptAsync(candidate, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
    return hash.length === expected.length && timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

/** Normalise a username handle: lowercase, trimmed, non-empty. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}
