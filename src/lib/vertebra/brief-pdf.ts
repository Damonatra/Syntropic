/**
 * Sealed audit brief — hand-rolled PDF generator (no external deps).
 *
 * Produces a valid multi-page PDF 1.4 document with the Helvetica base-14
 * fonts: the deliverable artifact of the $3,500 Diagnostic Audit. Content
 * lines are laid out with a y-cursor; pages break automatically.
 */
import { createHash } from "node:crypto";

export interface BriefLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** Extra points of vertical space after this line. */
  gapAfter?: number;
  /** Indent in points from the 54pt left margin. */
  indent?: number;
}

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 54;
const TOP_Y = 738;
const BOTTOM_Y = 56;
const LEADING = 1.42;

function esc(text: string): string {
  // Latin-1 fold + PDF string escaping.
  const folded = text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u00D7]/g, "x")
    .replace(/[\u2265]/g, ">=")
    .replace(/[\u2264]/g, "<=")
    .replace(/[\u2192]/g, "->")
    .replace(/[^\x20-\x7E]/g, "");
  return folded.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

interface RenderedPage {
  content: string;
}

function renderPages(lines: BriefLine[]): RenderedPage[] {
  const pages: RenderedPage[] = [];
  let content = "";
  let y = TOP_Y;

  const pushPage = () => {
    pages.push({ content });
    content = "";
    y = TOP_Y;
  };

  for (const line of lines) {
    const size = line.size ?? 10;
    const nextY = y - size * LEADING;
    if (nextY < BOTTOM_Y) pushPage();
    const font = line.bold ? "/F2" : "/F1";
    const x = MARGIN_X + (line.indent ?? 0);
    content += `BT ${font} ${size} Tf 1 0 0 1 ${x} ${y.toFixed(1)} Tm (${esc(line.text)}) Tj ET\n`;
    y -= size * LEADING + (line.gapAfter ?? 0);
  }
  pages.push({ content });
  return pages;
}

export function buildBriefPdf(lines: BriefLine[]): Buffer {
  const pages = renderPages(lines);

  const objects: string[] = [];
  const pageObjNums: number[] = [];
  // Object numbering: 1 catalog, 2 pages tree, 3 F1, 4 F2, then pairs.
  let nextNum = 5;
  for (let i = 0; i < pages.length; i++) {
    pageObjNums.push(nextNum);
    nextNum += 2;
  }

  const kids = pageObjNums.map((n) => `${n} 0 R`).join(" ");
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objects[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;

  pages.forEach((p, i) => {
    const pageNum = pageObjNums[i];
    const contentNum = pageNum + 1;
    const stream = p.content;
    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`;
    objects[contentNum] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`;
  });

  // Serialize with byte-accurate xref.
  let body = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    if (!objects[i]) continue;
    offsets[i] = Buffer.byteLength(body, "latin1");
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(body, "latin1");
  const maxObj = objects.length - 1;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObj; i++) {
    const off = offsets[i] ?? 0;
    xref += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, "latin1");
}

/** Deterministic seal id for the brief — content-bound, displayable. */
export function sealId(company: string, qlv: number | null, generatedAtMs: number): string {
  return createHash("sha256")
    .update(`${company}:${qlv ?? "na"}:${generatedAtMs}`)
    .digest("hex")
    .slice(0, 16);
}
