/**
 * GET /l/<token> — the prospect's landing page. The tracked funnel door.
 *
 * The token is an HMAC binding of the prospect id (track.ts) — a hit on
 * this page IS a portal_visit: the ledger writes the event, the intent
 * heat bumps (+6), and a critical-band prospect (QLV >= 85) pages the
 * operator's Telegram/Slack through the standard hour-deduped alert.
 * A bad token reads as a neutral expired-link page — no enumeration.
 */
import { db } from "@/lib/db";
import { verifyLandingToken } from "@/lib/vertebra/track";
import { recordPortalEvent } from "@/lib/vertebra/portal-events";
import { parseFactorsJson } from "@/lib/vertebra/scoring";

export const dynamic = "force-dynamic";

function Expired() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0B0C0B] px-6 text-center">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#5F6460]">Syntropic Industrial Growth</p>
        <h1 className="mt-4 text-[20px] font-semibold text-[#F4F5F2]">This link is no longer valid.</h1>
        <p className="mt-2 text-[13px] text-[#5F6460]">If you expected a quoting audit here, reply to the email you received and a fresh one goes out.</p>
      </div>
    </main>
  );
}

export default async function LandingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const prospectId = verifyLandingToken(token);
  if (!prospectId) return <Expired />;

  const prospect = await db.prospect.findUnique({
    where: { id: prospectId },
    include: { scores: { orderBy: { createdAt: "desc" }, take: 1 }, contacts: { take: 1 } },
  });
  if (!prospect) return <Expired />;

  // The visit IS the signal — ledger first, render second; a ledger failure
  // never blocks the prospect from seeing the page.
  try {
    await recordPortalEvent({
      prospectId: prospect.id,
      eventType: "portal_visit",
      source: "landing",
      sessionId: `landing-${Date.now().toString(36)}`,
      payload: { door: "email_landing" },
    });
  } catch (e) {
    console.warn("[landing] portal_visit not recorded:", String(e).slice(0, 120));
  }

  const score = prospect.scores[0];
  const factors = score ? parseFactorsJson(score.factorsJson) : [];
  const top = [...factors].sort((a, b) => b.points * b.weight - a.points * a.weight).slice(0, 3);
  const contact = prospect.contacts[0];

  return (
    <main className="min-h-screen bg-[#F4F5F2] px-6 py-14">
      <div className="mx-auto max-w-[620px]">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#5F6460]">Syntropic // Margin Defense</p>

        <h1 className="mt-5 text-[26px] font-semibold leading-tight tracking-[-0.02em] text-[#0B0C0B]">
          {prospect.name}: the quoting math, on one page
        </h1>
        <p className="mt-3 text-[14px] leading-relaxed text-[#3D423D]">
          {contact ? `${contact.firstName}, ` : ""}we profiled how quotes move through a desk like yours —{" "}
          {prospect.detectedErp ? `ERP on file: ${prospect.detectedErp}. ` : ""}
          The sealed audit below carries the numbers: annual net-margin leakage, the factor anatomy behind it, and what a recovery is worth in year one.
        </p>

        {top.length > 0 && (
          <ul className="mt-6 space-y-3">
            {top.map((f) => (
              <li key={f.key} className="rounded-lg border border-[#D9DBD6] bg-white p-4">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#5F6460]">
                  {f.key.replace(/_/g, " ")} · weight {(f.weight * 100).toFixed(0)}%
                </p>
                <p className="mt-1 text-[13px] leading-snug text-[#0B0C0B]">{f.evidence}</p>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-8 rounded-xl border border-[#0B0C0B] bg-[#0B0C0B] p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8A9088]">sealed audit brief</p>
          <h2 className="mt-2 text-[17px] font-semibold text-[#F4F5F2]">
            {score ? `Quote Leakage Vulnerability ${score.qlvScore}/100 — ${score.band} band` : "The verdict, sealed"}
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[#C8CCC4]">
            Opens as a PDF with a unique seal id binding it to {prospect.name}. No form, no gate — it is yours.
          </p>
          <a
            href={`/l/${token}/audit`}
            className="tactile-btn mt-5 inline-flex h-11 items-center rounded-lg bg-[#F4F5F2] px-6 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[#0B0C0B]"
          >
            Open the sealed audit
          </a>
        </div>

        <p className="mt-8 text-[12px] leading-relaxed text-[#5F6460]">
          Prepared for {contact ? `${contact.firstName} ${contact.lastName}` : "the operating principal"}
          {contact?.role ? `, ${contact.role}` : ""}. Questions before reading? Reply to the email that brought you here — it lands with a human.
        </p>
      </div>
    </main>
  );
}
