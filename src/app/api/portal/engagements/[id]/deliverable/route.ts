/**
 * GET /api/portal/engagements/[id]/deliverable — stream the generated audit
 * PDF. Gate-protected by the enclave middleware (session cookie required);
 * the file lives in db/deliverables, never in public/.
 */
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const engagement = await db.engagement.findUnique({
      where: { id },
      select: { ref: true, deliverableUrl: true },
    });
    if (!engagement || !engagement.deliverableUrl) {
      return NextResponse.json({ error: "not_found", hint: "no deliverable generated yet" }, { status: 404 });
    }
    const buf = await readFile(join(process.cwd(), "db", "deliverables", `${id}.pdf`));
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(buf.length),
        "content-disposition": `inline; filename="vertebra-audit-${engagement.ref}.pdf"`,
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "deliverable_unreadable" }, { status: 410 });
  }
}
