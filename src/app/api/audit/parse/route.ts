/**
 * POST /api/audit/parse — real server-side intake for the audit dropzone.
 *
 * What actually happens (no fabricated numbers):
 *   1. MIME + size gate (10 MB)
 *   2. SHA-256 content digest
 *   3. Extraction:
 *      • PDF — page count from the page tree + Flate stream inflation
 *        (zlib) with text-operator parsing for embedded text
 *      • CSV/TXT — RFC-4180-ish row parse, line-item detection on
 *        sku + qty + unit-price shapes
 *   4. Signals: line items, SPA references, distinct SKU tokens — only what
 *      the bytes actually contain
 *   5. Persisted as an AuditDocument row
 *
 * The Docling OCR → hybrid RRF → Qdrant stages are engine-side contract
 * stages (vertebra engine); the response marks them `engine_pending` so the
 * console can never present them as executed here.
 */
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { db } from "@/lib/db";
import { guardWrite } from "@/lib/vertebra/guard";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";

const MAX_BYTES = 10 * 1024 * 1024;

interface Extraction {
  extraction: "full_text" | "partial" | "header_only";
  pages: number | null;
  text: string;
  note: string;
}

function countPdfPages(buf: Buffer): number | null {
  const asLatin = buf.toString("latin1");
  const pageObjects = (asLatin.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  if (pageObjects > 0) return pageObjects;
  const countMatch = asLatin.match(/\/Count\s+(\d+)/);
  return countMatch ? Number(countMatch[1]) : null;
}

/** Adobe ASCII85 decode (PDF stream filter; 'z' shorthand, whitespace-tolerant). */
function ascii85Decode(input: string): Buffer {
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of input) {
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (ch < "!" || ch > "u") continue; // whitespace / EOD
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let val = 0;
      for (const g of group) val = val * 85 + g;
      out.push((val >>> 24) & 255, (val >>> 16) & 255, (val >>> 8) & 255, val & 255);
      group = [];
    }
  }
  if (group.length > 0) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let val = 0;
    for (const g of group) val = val * 85 + g;
    const bytes = [(val >>> 24) & 255, (val >>> 16) & 255, (val >>> 8) & 255, val & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Buffer.from(out);
}

/** Decode a PDF stream per its filter chain; null when undecodable. */
function decodePdfStream(dict: string, data: Buffer): Buffer | null {
  try {
    if (/ASCII85Decode/.test(dict) && /FlateDecode/.test(dict)) {
      return inflateSync(ascii85Decode(data.toString("latin1")));
    }
    if (/FlateDecode/.test(dict)) return inflateSync(data);
    if (!/Filter/.test(dict)) return data; // uncompressed content stream
    return null; // unsupported filter chain (encryption, DCT, …)
  } catch {
    return null;
  }
}

/** Inflate/filter streams and pull text-show operators out of each. */
function extractPdfText(buf: Buffer): string {
  const chunks: string[] = [];
  const raw = buf.toString("latin1");
  const streamRe = /<<([\s\S]{0,500}?)>>\s*stream\r?\n([\s\S]*?)endstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw)) !== null) {
    const dict = m[1];
    const slice = Buffer.from(m[2], "latin1");
    const content = decodePdfStream(dict, slice);
    if (!content) continue;
    const txt = content.toString("latin1");
    // Text-show operators: (string) Tj and [(s1) n (s2)] TJ
    const tjRe = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ|')/g;
    let t: RegExpExecArray | null;
    while ((t = tjRe.exec(txt)) !== null) {
      const s = t[1]
        .replace(/\\([()\\])/g, "$1")
        .replace(/\\[0-7]{3}/g, " ")
        .replace(/\\n/g, " ");
      if (s.trim()) chunks.push(s);
    }
  }
  // One text-show operator ≈ one drawn row — keep line structure for parsing.
  return chunks.join("\n");
}

interface LineItem {
  sku: string | null;
  qty: number | null;
  unitPrice: number | null;
  description: string | null;
}

const PRICE_RE = /(?:\$|USD\s?)?(\d{1,6}(?:,\d{3})*(?:\.\d{2})?)/;

/** Parse CSV/TXT rows into line-item candidates; sku/qty/price by shape. */
function extractLineItems(text: string): LineItem[] {
  const items: LineItem[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length < 6) continue;
    // Delimiter-separated first; fall back to column-aligned whitespace rows
    // (how most PDF quote sheets are drawn).
    let cells = line.split(/[,;\t|]/).map((c) => c.trim());
    if (cells.length < 2) cells = line.split(/\s{2,}/).map((c) => c.trim());
    if (cells.length < 2) continue;
    const sku = cells.find((c) => /^[A-Z0-9][A-Z0-9\-/]{3,}$/i.test(c)) ?? null;
    const priceCell = [...cells].reverse().find((c) => /^\$?\d{1,6}(?:,\d{3})*\.\d{2}$/.test(c));
    const qtyCell = cells.slice(1).find((c) => /^\d{1,5}$/.test(c));
    const price = priceCell ? Number(priceCell.replace(/[$,]/g, "")) : null;
    const qty = qtyCell ? Number(qtyCell) : null;
    // A line item needs a price; qty/sku strengthen but price is the anchor.
    if (price == null || price <= 0 || price > 10_000_000) continue;
    items.push({
      sku,
      qty,
      unitPrice: price,
      description: cells.find((c) => c.length > 6 && !PRICE_RE.test(c) && c !== sku) ?? null,
    });
    if (items.length >= 5_000) break;
  }
  return items;
}

export async function POST(request: Request) {
  const denied = guardWrite(request, "audit/parse", { key: false, limit: 12, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file_required" }, { status: 400 });
    }
    if (file.size === 0 || file.size > MAX_BYTES) {
      return NextResponse.json({ error: "file_size_invalid", maxBytes: MAX_BYTES }, { status: 413 });
    }

    const prospectId = (form.get("prospectId") as string | null)?.trim() || null;
    if (prospectId) {
      const exists = await db.prospect.findUnique({ where: { id: prospectId }, select: { id: true } });
      if (!exists) return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });
    }

    // M3 — engagement binding: evidence sealed to the paid engagement that
    // needs it. Unbound drops stay possible (the legacy orphan door), but the
    // desk always posts with engagementId so parsed forensics accumulate.
    const engagementId = (form.get("engagementId") as string | null)?.trim() || null;
    if (engagementId) {
      const engagement = await db.engagement.findUnique({ where: { id: engagementId }, select: { id: true } });
      if (!engagement) return NextResponse.json({ error: "engagement_not_found" }, { status: 404 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const mime = file.type || "application/octet-stream";

    let extraction: Extraction;
    if (mime === "application/pdf" || /\.pdf$/i.test(file.name)) {
      const pages = countPdfPages(buf);
      const text = extractPdfText(buf);
      extraction = {
        extraction: text.length > 400 ? "full_text" : text.length > 40 ? "partial" : "header_only",
        pages,
        text,
        note:
          text.length > 40
            ? "flate streams inflated, text operators parsed"
            : "no embedded text recovered — likely scanned raster; engine-side Docling OCR required",
      };
    } else if (mime.startsWith("text/") || /\.(csv|txt|tsv)$/i.test(file.name)) {
      const text = buf.toString("utf8");
      extraction = {
        extraction: text.length > 200 ? "full_text" : "partial",
        pages: null,
        text,
        note: "plain-text row parse",
      };
    } else {
      return NextResponse.json(
        { error: "unsupported_mime", supported: ["application/pdf", "text/csv", "text/plain", "text/tsv"] },
        { status: 415 },
      );
    }

    const items = extractLineItems(extraction.text);
    const spaRefs = (extraction.text.match(/\bSPA\b|\bspecial pricing agreement\b/gi) ?? []).length;
    const distinctSkus = new Set(items.map((i) => i.sku).filter(Boolean)).size;

    // Idempotent evidence: the same bytes dropped twice on the same engagement
    // resolve to the existing row — the forensics locker never double-counts
    // a document, and the ledger never double-writes the event.
    if (engagementId) {
      const prior = await db.auditDocument.findFirst({
        where: { engagementId, sha256 },
        select: { id: true, fileName: true, lineItems: true },
      });
      if (prior) {
        return NextResponse.json({
          ok: true,
          duplicate: true,
          documentId: prior.id,
          fileName: prior.fileName,
          mimeType: mime,
          sizeBytes: file.size,
          sha256: sha256.slice(0, 16),
          pages: extraction.pages,
          lineItems: prior.lineItems ?? items.length,
          spaReferences: spaRefs,
          distinctSkus,
          extraction: extraction.extraction,
          note: "identical bytes already sealed to this engagement",
          sampleItems: [],
          engineStages: { docling_ocr: "engine_pending", hybrid_rrf_qdrant: "engine_pending" },
        });
      }
    }

    const doc = await db.auditDocument.create({
      data: {
        prospectId,
        engagementId,
        fileName: file.name.slice(0, 200),
        mimeType: mime.slice(0, 100),
        sizeBytes: file.size,
        sha256,
        pages: extraction.pages,
        lineItems: items.length,
        extraction: extraction.extraction,
        findingsJson: JSON.stringify({
          note: extraction.note,
          spaReferences: spaRefs,
          distinctSkus,
          sampleItems: items.slice(0, 8),
          engineStages: { docling_ocr: "engine_pending", hybrid_rrf_qdrant: "engine_pending" },
        }),
      },
    });

    // The desk's ledger records every piece of evidence that entered the room.
    if (engagementId) {
      await db.engagementEvent.create({
        data: {
          engagementId,
          kind: "document_added",
          actor: "operator",
          detail: `${doc.fileName} · ${items.length} line items · ${extraction.extraction.replace(/_/g, " ")}`,
        },
      });
      invalidateSnapshot();
    }

    return NextResponse.json({
      ok: true,
      documentId: doc.id,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      sha256: sha256.slice(0, 16),
      pages: extraction.pages,
      lineItems: items.length,
      spaReferences: spaRefs,
      distinctSkus,
      extraction: extraction.extraction,
      note: extraction.note,
      sampleItems: items.slice(0, 8),
      engineStages: { docling_ocr: "engine_pending", hybrid_rrf_qdrant: "engine_pending" },
    });
  } catch (error) {
    console.error("[api/audit/parse] failed", error);
    return NextResponse.json({ error: "parse_failed" }, { status: 500 });
  }
}
