/**
 * GET/POST /api/unsubscribe — RFC 8058 one-click unsubscribe + CASL ledger.
 *
 * GET  renders a minimal confirmation page (link clicks from email footers).
 * POST carries `List-Unsubscribe=One-Click` (mailbox one-click) and returns
 * JSON per RFC 8058 expectations.
 *
 * Both verify the HMAC token binding prospect+address before touching state,
 * then: upsert SuppressionRecord, stop all Channel A dispatches, log an
 * operator note for the audit trail.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyToken } from "@/lib/vertebra/casl";
import { guardWrite } from "@/lib/vertebra/guard";

async function processUnsubscribe(
  prospectId: string,
  address: string,
  token: string,
  source: "unsubscribe_link" | "one_click",
): Promise<{ ok: boolean; error?: string }> {
  if (!prospectId || !address || !token) return { ok: false, error: "missing_params" };
  if (!verifyToken(prospectId, address, token)) return { ok: false, error: "invalid_token" };

  const email = address.toLowerCase();
  await db.suppressionRecord.upsert({
    where: { email },
    create: { email, prospectId, reason: "unsubscribe", source },
    update: { reason: "unsubscribe", source, prospectId },
  });

  await db.dispatch.updateMany({
    where: { prospectId, channel: "channel_a_automated_email", status: { in: ["queued", "sent", "opened"] } },
    data: { status: "stopped", error: `unsubscribed via ${source}` },
  });

  await db.operatorAction.create({
    data: { prospectId, action: "note", note: `Suppression recorded (${source}): ${email}` },
  });

  return { ok: true };
}

function confirmationPage(address: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Unsubscribed — Syntropic</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0B0C0B;color:#F4F5F2;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .card{max-width:520px;padding:40px;border:1px solid #232623;border-radius:12px}
  h1{font-size:18px;letter-spacing:.02em;margin:0 0 12px}
  p{font-size:13px;line-height:1.7;color:#8E9194;margin:0}
  .tag{font-size:10px;letter-spacing:.22em;color:#6E736E;text-transform:uppercase;margin-bottom:24px}
  code{color:#F4F5F2}
</style></head>
<body><div class="card">
  <div class="tag">Syntropic // Margin Defense</div>
  <h1>You're off the list.</h1>
  <p><code>${address.replace(/</g, "&lt;")}</code> has been added to the suppression ledger. All automated sequences for this account are stopped, effective immediately — no further sends, no re-adding through list rotations.</p>
</div></body></html>`;
}

function rejectPage(reason: string): string {
  const msg =
    reason === "invalid_token"
      ? "The unsubscribe link is invalid or was truncated by your mail client. Reply to any past email and we will remove you manually within one business day."
      : "The unsubscribe request was malformed. Reply to any past email and we will remove you manually within one business day.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Unsubscribe — Syntropic</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0B0C0B;color:#F4F5F2;font-family:ui-monospace,monospace}.card{max-width:520px;padding:40px;border:1px solid #232623;border-radius:12px}h1{font-size:18px;margin:0 0 12px}p{font-size:13px;line-height:1.7;color:#8E9194;margin:0}.tag{font-size:10px;letter-spacing:.22em;color:#6E736E;text-transform:uppercase;margin-bottom:24px}</style>
</head><body><div class="card"><div class="tag">Syntropic // Margin Defense</div><h1>Link not honored.</h1><p>${msg}</p></div></body></html>`;
}

export async function GET(request: NextRequest) {
  const limited = guardWrite(request, "unsubscribe", { key: false, limit: 20, windowMs: 60_000 });
  if (limited) return limited;
  const p = request.nextUrl.searchParams.get("p") ?? "";
  const a = request.nextUrl.searchParams.get("a") ?? "";
  const t = request.nextUrl.searchParams.get("t") ?? "";
  const result = await processUnsubscribe(p, a, t, "unsubscribe_link");
  const html = result.ok ? confirmationPage(a) : rejectPage(result.error ?? "missing_params");
  return new NextResponse(html, { status: result.ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function POST(request: NextRequest) {
  const limited = guardWrite(request, "unsubscribe", { key: false, limit: 20, windowMs: 60_000 });
  if (limited) return limited;
  // RFC 8058 one-click: params may arrive in the body as form-urlencoded.
  const form = await request.formData().catch(() => null);
  const p = (form?.get("p") as string) ?? request.nextUrl.searchParams.get("p") ?? "";
  const a = (form?.get("a") as string) ?? request.nextUrl.searchParams.get("a") ?? "";
  const t = (form?.get("t") as string) ?? request.nextUrl.searchParams.get("t") ?? "";
  const result = await processUnsubscribe(p, a, t, "one_click");
  return NextResponse.json(result.ok ? { ok: true } : { ok: false, error: result.error }, {
    status: result.ok ? 200 : 400,
  });
}
