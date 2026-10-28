import { randomBytes } from 'node:crypto';

/**
 * Portal invite code generation.
 *
 * Codes are operator-visible exactly once at issue time (reveal-once in the
 * Tower, then only the sha256 hash is persisted — see TenantInvite.codeHash).
 * Alphabet excludes visually ambiguous glyphs (0/O, 1/I/L) so codes survive
 * being read out over a phone call.
 */

// Unambiguous 32-glyph alphabet (no 0/O/1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomGroup(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** "Apex Piping & Supply" → "apex-K7QM-R2K4" */
export function generateAccessCode(tenantName: string): string {
  const slug =
    tenantName
      .split(/[^a-zA-Z]+/)
      .filter(Boolean)[0]
      ?.toLowerCase() ?? 'client';
  return `${slug}-${randomGroup(4)}-${randomGroup(4)}`;
}

/** Masked form for persistent UI display: "apex-K7QM-R2K4" → "apex-K•••-••K4" */
export function codeHint(code: string): string {
  const parts = code.split('-');
  if (parts.length < 3) return '••••';
  const [head, mid, tail] = parts;
  return `${head}-${mid[0]}•••-••${tail.slice(-2)}`;
}
