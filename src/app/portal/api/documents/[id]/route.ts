import { readFile, stat } from 'fs/promises';
import path from 'path';
import { db } from '@/lib/db';
import { sessionTenant } from '@/lib/portal-session';

export const dynamic = 'force-dynamic';

/**
 * GET /portal/api/documents/[id] — stream the client's own uploaded file
 * back from DATA_DIR (Task 19 document shelf).
 *
 * Session-scoped like every /portal/api surface: the document must belong
 * to the session's tenant or it answers 404 (not 403 — existence is not
 * disclosed across the boundary). storedPath was written by our own ingest
 * route, but it is re-validated against traversal before any read.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const tenant = await sessionTenant();
  if (!tenant) {
    return Response.json({ error: 'Sign in required' }, { status: 401 });
  }
  const { id } = await params;

  const doc = await db.tenantDocument.findUnique({ where: { id } });
  if (!doc || doc.tenantId !== tenant.id) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const dataDir = process.env.DATA_DIR || './data';
  const safeRelative = path.normalize(doc.storedPath).replace(/^(\.\.(\/|\\|$))+/, '');
  if (safeRelative.split(path.sep).includes('..')) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  const abs = path.join(dataDir, safeRelative);

  try {
    const info = await stat(abs);
    if (!info.isFile()) throw new Error('not a file');
    const bytes = await readFile(abs);
    const ext = path.extname(doc.fileName).toLowerCase();
    const mime =
      ext === '.pdf'
        ? 'application/pdf'
        : ext === '.csv'
          ? 'text/csv; charset=utf-8'
          : ext === '.xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'application/octet-stream';
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(info.size),
        'Content-Disposition': `attachment; filename="${doc.fileName.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return Response.json(
      { error: 'file_missing', detail: 'The stored file is no longer on disk — ask your operator to re-share it.' },
      { status: 404 },
    );
  }
}
