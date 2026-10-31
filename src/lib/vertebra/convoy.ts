/**
 * The convoy — the human escort layer for Channel A step 1.
 *
 * When the first autonomous email of a prospect's sequence leaves the
 * enclave, the machine pages the operators with the one thing a machine
 * cannot do: the touch call. Company, executive, the evidence hook, the
 * direct line, and a call window measured from the send — the outreach
 * email lands, and inside fifteen minutes a human voice follows it.
 *
 * Doctrine translation of the ad-hoc sketch this replaces:
 *   · paging goes through pager.ts (correct Telegram Bot API shape +
 *     Slack fan-out, 4 s timeouts, honest delivered/attempted) — never a
 *     hand-rolled requests.post against a "webhook url" that is really
 *     a Slack payload
 *   · the ledger is written FIRST (claim pulse), the page SECOND — a
 *     retried tick can never double-page, and a page that lands with no
 *     live channel still leaves an honest row in the ops pulses
 *   · at-most-once pages, by design: a lost page is visible as a pulse
 *     with zero delivered channels; a duplicate 3 a.m. page is worse
 *   · pause-on-reply is NOT re-implemented here — tiered autonomy in
 *     replies.ts already stops, reschedules, and hand-offs; clicks
 *     escalate a dispatch's status on purpose (weak signal, no pause)
 *   · the calendar task stays behind the registry gate (google-calendar,
 *     staged) — until that integration is armed, the page IS the task,
 *     ack-not-store; no second queue is minted for Channel A
 *
 * Failure isolation: runConvoyForDispatch never throws into the tick.
 * Every exit is a named reason.
 */
import { db } from "@/lib/db";
import { deliverAlert } from "@/lib/vertebra/pager";
import { writeEnginePulse } from "@/lib/vertebra/pulse";

export const CONVOY_ENGINE_ID = "convoy-escort";
export const CONVOY_CALL_LEAD_MIN = 2;
export const CONVOY_CALL_WINDOW_MIN = 15;

export interface ConvoyCallWindow {
  from: Date;
  to: Date;
}

/** The call window: opens 2 minutes after send, closes 15 minutes after. */
export function convoyCallWindow(sentAt: Date, leadMin = CONVOY_CALL_LEAD_MIN, windowMin = CONVOY_CALL_WINDOW_MIN): ConvoyCallWindow {
  return {
    from: new Date(sentAt.getTime() + leadMin * 60_000),
    to: new Date(sentAt.getTime() + windowMin * 60_000),
  };
}

function clockHHMM(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
}

export function convoyPageTitle(): string {
  return "CHANNEL A · EMAIL 1 OUT — touch call for Josias";
}

export interface ConvoyPageInput {
  company: string;
  exec: string;
  execTitle: string | null;
  hook: string | null;
  phone: string | null;
  window: ConvoyCallWindow;
  sentAt: Date;
}

/** Plain text only — pager channels render it verbatim; no markdown escaping class of bugs. */
export function convoyPageBody(input: ConvoyPageInput): string {
  const lines = [
    `Company: ${input.company}`,
    `Executive: ${input.exec}${input.execTitle ? ` (${input.execTitle})` : ""}`,
    `Evidence hook: ${input.hook ? (input.hook.length > 200 ? `${input.hook.slice(0, 197)}…` : input.hook) : "none on the ledger yet"}`,
    `Direct line: ${input.phone ?? "pending — resolve in the Dossier before dialing"}`,
    `Call window: ${clockHHMM(input.window.from)}–${clockHHMM(input.window.to)} (opens ${CONVOY_CALL_LEAD_MIN} min after send, ${CONVOY_CALL_WINDOW_MIN} min total)`,
    `Sent at: ${input.sentAt.toISOString()}`,
    `Sequence: autonomous. A reply routes to tiered autonomy — do not batch-follow-up by hand.`,
  ];
  return lines.join("\n");
}

export interface ConvoyOutcome {
  fired: boolean;
  reason?: string;
  attempted: string[];
  delivered: string[];
}

/**
 * The post-send hook. Call exactly once, right after a Channel A dispatch
 * transitions to "sent". Fires the page only for the prospect's FIRST
 * Channel A send (step 1); steps 2+ ride silently.
 */
export async function runConvoyForDispatch(dispatchId: string): Promise<ConvoyOutcome> {
  // 1. Load the dispatch composite — a ledger the hook cannot read exits
  //    with a named reason, it never pages on partial truth.
  let row: {
    id: string;
    status: string;
    channel: string;
    prospectId: string;
    prospect: {
      name: string;
      contacts: Array<{ firstName: string; lastName: string; phone: string | null; role: string | null }>;
      scores: Array<{ hooksJson: string }>;
    };
  } | null = null;
  try {
    row = await db.dispatch.findUnique({
      where: { id: dispatchId },
      select: {
        id: true,
        status: true,
        channel: true,
        prospectId: true,
        prospect: {
          select: {
            name: true,
            contacts: { take: 1, select: { firstName: true, lastName: true, phone: true, role: true } },
            scores: { orderBy: { createdAt: "desc" }, take: 1, select: { hooksJson: true } },
          },
        },
      },
    });
  } catch {
    return { fired: false, reason: "convoy_ledger_unavailable: the dispatch could not be read — no page on partial truth", attempted: [], delivered: [] };
  }
  if (!row) return { fired: false, reason: "dispatch_not_found", attempted: [], delivered: [] };
  if (row.channel !== "channel_a_automated_email") return { fired: false, reason: "not_channel_a", attempted: [], delivered: [] };
  if (row.status !== "sent") return { fired: false, reason: `dispatch_not_sent (${row.status})`, attempted: [], delivered: [] };

  // 2. Step-1 check: any OTHER Channel A dispatch for this prospect already
  //    past queued means this send is a sequence step, not the opener.
  try {
    const prior = await db.dispatch.count({
      where: {
        prospectId: row.prospectId,
        channel: "channel_a_automated_email",
        id: { not: dispatchId },
        status: { in: ["sent", "delivered", "opened", "clicked", "replied"] },
      },
    });
    if (prior > 0) return { fired: false, reason: "not_step_one", attempted: [], delivered: [] };
  } catch {
    return { fired: false, reason: "convoy_ledger_unavailable: the step-1 count could not be read", attempted: [], delivered: [] };
  }

  const contact = row.prospect.contacts[0];
  const hook = (() => {
    try {
      const hooks = row.prospect.scores[0] ? (JSON.parse(row.prospect.scores[0].hooksJson) as Array<{ body: string }>) : [];
      return hooks[0]?.body ?? null;
    } catch {
      return null;
    }
  })();
  const now = new Date();
  const window = convoyCallWindow(now);

  // 3. Claim first, page second — UNIQUE(engineId, pulseRef) makes a
  //    retried tick absorb, never double-page.
  let claimed = true;
  try {
    const res = await writeEnginePulse({
      engineId: CONVOY_ENGINE_ID,
      pulseRef: `page:${dispatchId}`,
      watchId: "convoy_page",
      status: "ok",
      detail: `${row.prospect.name} — Email 1 out, touch call tasked`,
    });
    if (res.deduped) claimed = false;
  } catch {
    // A pulse write failure must not block the page for a real send —
    // idempotency degrades to best-effort, the page still goes once.
    claimed = true;
  }
  if (!claimed) return { fired: false, reason: "already_paged", attempted: [], delivered: [] };

  // 4. Page through the pager — correct wire shapes, timeouts, honest outcome.
  const outcome = await deliverAlert(
    convoyPageTitle(),
    convoyPageBody({
      company: row.prospect.name,
      exec: contact ? `${contact.firstName} ${contact.lastName}`.trim() || "unnamed contact" : "contact pending on the ledger",
      execTitle: contact?.role ?? null,
      hook,
      phone: contact?.phone ?? null,
      window,
      sentAt: now,
    }),
  );
  return { fired: true, attempted: outcome.attempted, delivered: outcome.delivered };
}
