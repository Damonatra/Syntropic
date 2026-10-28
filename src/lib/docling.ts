/**
 * THE ENGINE SWAP POINT — spatial quote parser.
 *
 * The demo implementation below is deterministic and dependency-free so the
 * full pipeline (ingest → confidence floor → HITL queue → Telegram inline
 * approval → margin attach) is exercisable end-to-end without a Python
 * runtime. Production replaces parseQuoteFile with a call to the real
 * Docling spatial-parsing service; nothing else in the pipeline changes —
 * the contract is `Promise<ParsedLine[]>` with per-line confidence in [0,1].
 */

export interface ParsedLine {
  lineNumber: number;
  rawText: string;
  confidence: number; // 0..1 — anything below HITL_CONFIDENCE_FLOOR queues for human review
}

export const HITL_CONFIDENCE_FLOOR = 0.95;

/** Stable pseudo-loss estimate for demo parser rows (no Math.random — same
 *  file always produces the same queue, which keeps tests reproducible). */
export function demoMarginLossCents(fileName: string, lineNumber: number): number {
  let h = 0;
  const s = `${fileName}:${lineNumber}`;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 18_000 + (h % 402_000); // $180 – $4,200
}

export async function parseQuoteFile(fileName: string): Promise<ParsedLine[]> {
  const count = 3 + (fileName.length % 5);
  const lines: ParsedLine[] = [];
  for (let i = 0; i < count; i += 1) {
    const low = i === count - 1; // last line always trips the floor so the HITL path demos
    lines.push({
      lineNumber: i + 1,
      rawText: `${fileName} — line ${i + 1} · sample part shorthand (Docling demo)`,
      confidence: low ? 0.86 + ((fileName.length % 8) / 100) : 0.994,
    });
  }
  return lines;
}
