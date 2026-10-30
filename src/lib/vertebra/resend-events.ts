/**
 * Resend event → ledger effect mapping (pure, unit-tested).
 *
 * The events door translates provider delivery feedback into the same
 * vocabulary the console already speaks:
 *
 *   email.sent        queued → sent                    (transport accepted)
 *   email.delivered   sent/queued/opened → delivered   (mailbox took it)
 *   email.opened      queued/sent → opened             (escalate only)
 *   email.bounced     → failed; PERMANENT bounces also suppress the
 *                       address and stop the prospect's active sequences
 *                       (a dead address is a suppression fact, not a retry
 *                       candidate); transient bounces fail the dispatch
 *                       but leave the address alone — mailbox-full recovers.
 *   email.complained  → stopped + suppression + stop sequences. A spam
 *                       complaint is the loudest no in email; it lands in
 *                       the same ledger an unsubscribe does.
 *
 * Unknown event types are acknowledged and ignored — a webhook must 200 or
 * the provider retries forever.
 */

export type EventEffect = {
  dispatchStatus: "sent" | "delivered" | "opened" | "failed" | "stopped";
  /** dispatch statuses eligible for the transition (none = dispatch untouched) */
  fromStatuses: readonly string[];
  suppressionReason: null | "bounce" | "complaint";
  stopSequences: boolean;
  pulseStatus: "ok" | "warn";
};

const NONE: readonly string[] = [];

export function resolveEventEffect(eventType: string, bounceType: string | null | undefined): EventEffect | null {
  switch (eventType) {
    case "email.sent":
      return { dispatchStatus: "sent", fromStatuses: ["queued"], suppressionReason: null, stopSequences: false, pulseStatus: "ok" };
    case "email.delivered":
      return { dispatchStatus: "delivered", fromStatuses: ["queued", "sent", "opened"], suppressionReason: null, stopSequences: false, pulseStatus: "ok" };
    case "email.opened":
      return { dispatchStatus: "opened", fromStatuses: ["queued", "sent"], suppressionReason: null, stopSequences: false, pulseStatus: "ok" };
    case "email.bounced": {
      const permanent = (bounceType ?? "").toLowerCase() === "permanent";
      return {
        dispatchStatus: "failed",
        fromStatuses: NONE, // failed unconditionally — the send did not land
        suppressionReason: permanent ? "bounce" : null,
        stopSequences: permanent,
        pulseStatus: "warn",
      };
    }
    case "email.complained":
      return { dispatchStatus: "stopped", fromStatuses: NONE, suppressionReason: "complaint", stopSequences: true, pulseStatus: "warn" };
    default:
      return null;
  }
}
