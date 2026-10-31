/**
 * GET /l/<token>/audit — the prospect's sealed audit, delivered.
 *
 * The email promised the artifact with no form and no gate; this door
 * honors that. A download IS a document_download event: heat +12, the
 * dossier timeline grows, and a critical-band prospect pages the operator
 * through the standard high-intent alert. The ledger never blocks the
 * delivery — the PDF goes out even if the event write hiccups.
 */
import { verifyLandingToken } from "@/lib/vertebra/track";
import { recordPortalEvent } from "@/lib/vertebra/portal-events";
import { buildProspectBrief } from "@/lib/vertebra/prospect-brief";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const prospectId = verifyLandingToken(token);
  if (!prospectId) {
    return new Response("This link is no longer valid.", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  try {
    await recordPortalEvent({
      prospectId,
      eventType: "document_download",
      source: "audit",
      sessionId: `audit-${Date.now().toString(36)}`,
      url: new URL(request.url).pathname,
      userAgent: request.headers.get("user-agent"),
      payload: { door: "email_landing_audit" },
    });
  } catch (e) {
    console.warn("[landing/audit] document_download not recorded:", String(e).slice(0, 120));
  }

  const brief = await buildProspectBrief(prospectId);
  if (!brief.ok) {
    return new Response("The audit brief is being prepared — reply to your email and we will send it directly.", {
      status: brief.error === "prospect_unscored" ? 409 : 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response(new Uint8Array(brief.pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${brief.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
