import { NextResponse } from 'next/server';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { sessionTenant } from '@/lib/portal-session';
import { parseQuoteFile, HITL_CONFIDENCE_FLOOR, demoMarginLossCents } from '@/lib/docling';
import { createOcrHitl } from '@/lib/backbone-service';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { recordTraffic } from '@/lib/traffic';
import { resolveGeo } from '@/lib/geo';

export const dynamic = 'force-dynamic';

/**
 * POST /portal/api/ingest — tenant-session-scoped file ingest (multipart
 * `files`). Lives under /portal/api so the enclave cookie never crosses the
 * Tower's cross-tenant /api/* surface (same isolation as login/enclave).
 *
 * Gate chain: session (401) → $3,500 deposit PAID (402) → per-tenant rate
 * limit (429). Accepted PDFs/XLSX/CSV land in DATA_DIR/tenants/<tenant>/,
 * each file is parsed by the Docling swap point (lib/docling.ts), and every
 * line under the 95% confidence floor becomes a HITL queue item with a
 * Telegram inline approval card addressed to the owning founder.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`ingest:${ip}`, 20, 3600e3)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const tenant = await sessionTenant();
  if (!tenant) {
    return NextResponse.json({ error: 'tenant_session_required' }, { status: 401 });
  }
  if (tenant.paymentStatus !== 'PAID') {
    return NextResponse.json(
      { error: 'ingest_locked', detail: 'File ingest requires an active $3,500 Diagnostic Audit deposit.' },
      { status: 402 },
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'expected_multipart' }, { status: 400 });

  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'no_files', detail: 'Attach one or more PDF/XLSX/CSV quote files.' }, { status: 422 });
  }

  await ensureDb();
  const dataDir = process.env.DATA_DIR || './data';
  const dirSafe = tenant.name.replace(/[^a-zA-Z0-9 _-]/g, '_');
  const dir = path.join(dataDir, 'tenants', dirSafe);
  await mkdir(dir, { recursive: true });

  let queued = 0;
  let hitlCount = 0;
  const refs: string[] = [];
  const perFileSummary: { fileName: string; lines: number; hitl: number }[] = [];
  const docIds: string[] = [];

  for (const f of files) {
    if (!/\.(pdf|xlsx|csv)$/i.test(f.name) || f.size > 50 * 1048576) continue;
    const bytes = Buffer.from(await f.arrayBuffer());
    const safe = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storedName = `${Date.now()}_${safe}`;
    await writeFile(path.join(dir, storedName), bytes);
    queued += 1;

    const parsed = await parseQuoteFile(f.name);
    const low = parsed.filter((l) => l.confidence < HITL_CONFIDENCE_FLOOR);
    let fileHitl = 0;
    const fileRefs: string[] = [];
    for (const line of low) {
      const res = await createOcrHitl({
        tenantName: tenant.name,
        pdfName: f.name,
        skuParsed: line.rawText,
        confidenceScore: Math.round(line.confidence * 1000) / 10, // 0-100, one decimal
        extractedMarginLossCents: demoMarginLossCents(f.name, line.lineNumber),
      });
      refs.push(res.item.ref);
      fileRefs.push(res.item.ref);
      fileHitl += 1;
      hitlCount += 1;
    }
    perFileSummary.push({ fileName: f.name, lines: parsed.length, hitl: fileHitl });

    // Task 19 — the document shelf row: what landed, what parsed, what
    // got flagged. This row is what the enclave shelf shows and what the
    // download route serves back, so the client always sees their own files.
    const doc = await db.tenantDocument.create({
      data: {
        tenantId: tenant.id,
        fileName: f.name,
        storedPath: path.join('tenants', dirSafe, storedName),
        sizeBytes: bytes.byteLength,
        linesParsed: parsed.length,
        hitlCount: fileHitl,
        hitlRefs: JSON.stringify(fileRefs),
      },
    });
    docIds.push(doc.id);
  }

  if (queued === 0) {
    return NextResponse.json({ error: 'no_accepted_files', detail: 'Only PDF/XLSX/CSV under 50 MB are accepted.' }, { status: 422 });
  }

  // Phase 11.8: edge-first geo rides along with the enclave capture.
  const { geo } = resolveGeo(req.headers, ip === 'local' ? null : ip);
  void recordTraffic({
    sessionId: tenant.name,
    layer: 'PORTAL',
    eventType: 'FILE_UPLOAD',
    ip,
    tenantId: tenant.name,
    geo,
    metadata: { queued, hitl: hitlCount },
  });

  return NextResponse.json({ ok: true, tenantName: tenant.name, filesQueued: queued, hitlCount, refs, perFileSummary, docIds }, { status: 201 });
}
