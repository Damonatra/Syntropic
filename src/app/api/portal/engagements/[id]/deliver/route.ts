/**
 * POST /api/portal/engagements/[id]/deliver — generate the audit deliverable.
 *
 * The artifact is built from REAL system data only: the engagement ledger
 * row, the intake facts, the unified leakage model output (stamped with the
 * model version), the audit cross-check when the matched prospect carries a
 * QLV score and revenue estimate, the operator's recorded verdict, the
 * sealed evidence inventory (SHA-256 per document) and the append-only
 * ledger trail verbatim. No number exists in the PDF that cannot be traced
 * to a row in this database.
 *
 * Gate: the verdict must be decided first (guaranteeCleared + confirmed
 * leakage on the ledger) — the $10,000 guarantee decision precedes the
 * deliverable, always. Regeneration overwrites the file; the ledger records
 * every generation.
 */
import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";
import { guardWrite } from "@/lib/vertebra/guard";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";
import { buildBriefPdf } from "@/lib/vertebra/brief-pdf";
import { buildAuditBriefLines } from "@/lib/vertebra/brief-build";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = guardWrite(request, "portal/deliver", { key: false, limit: 20, windowMs: 60_000 });
  if (denied) return denied;

  const { id } = await context.params;
  try {
    const engagement = await db.engagement.findUnique({
      where: { id },
      include: {
        prospect: {
          select: {
            id: true,
            name: true,
            revenueEstimateUsd: true,
            scores: { take: 1, orderBy: { createdAt: "desc" }, select: { qlvScore: true } },
          },
        },
        documents: { orderBy: { createdAt: "asc" } },
        events: { orderBy: { createdAt: "desc" }, take: 14 },
      },
    });
    if (!engagement) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // The commitment gate mirrors PATCH stage→delivered: no artifact leaves
    // the enclave before the guarantee decision is on the ledger.
    if (engagement.guaranteeCleared == null || engagement.confirmedLeakageUsd == null) {
      return NextResponse.json(
        { error: "verdict_required", hint: "record the guarantee decision before generating the deliverable" },
        { status: 409 },
      );
    }

    // ---- the artifact — the same composition the engine's tick renders ---- //
    const generatedAt = new Date();
    const { lines, seal } = buildAuditBriefLines(engagement, generatedAt);
    const pdf = buildBriefPdf(lines);

    const dir = join(process.cwd(), "db", "deliverables");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${engagement.id}.pdf`);
    await writeFile(file, pdf);
    const deliverableUrl = `/api/portal/engagements/${engagement.id}/deliverable`;
    const regenerated = engagement.deliverableUrl != null;

    await db.engagement.update({ where: { id }, data: { deliverableUrl } });
    await db.engagementEvent.create({
      data: {
        engagementId: id,
        kind: "deliverable_generated",
        actor: "operator",
        detail: `${regenerated ? "regenerated" : "generated"} audit deliverable · ${(pdf.length / 1024).toFixed(1)} kb · seal ${seal}`,
      },
    });
    invalidateSnapshot();

    return NextResponse.json({ ok: true, deliverableUrl, regenerated, bytes: pdf.length, seal });
  } catch (error) {
    console.error("[api/portal/engagements/deliver] failed", error);
    return NextResponse.json({ error: "deliver_failed" }, { status: 500 });
  }
}
