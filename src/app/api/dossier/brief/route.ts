/**
 * GET /api/dossier/brief?id=… — the operator's sealed audit brief for one
 * prospect. The line math lives in prospect-brief.ts (shared with the
 * prospect's own /l/<token>/audit door — the operator and the prospect see
 * the same artifact, no second math to drift).
 */
import { NextResponse } from "next/server";
import { buildProspectBrief } from "@/lib/vertebra/prospect-brief";

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });

    const brief = await buildProspectBrief(id);
    if (!brief.ok) {
      return NextResponse.json({ error: brief.error }, { status: brief.error === "prospect_not_found" ? 404 : 409 });
    }

    return new NextResponse(new Uint8Array(brief.pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${brief.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[api/dossier/brief] failed", error);
    return NextResponse.json({ error: "brief_failed" }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
