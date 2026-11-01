/**
 * One-off: fire one real notice through the full dual-destination pager —
 * operator private chat + the Operations team group — proving the fan-out.
 * Prints the honest PagerOutcome; no secrets cross stdout.
 */
import { deliverNotice } from "../../src/lib/vertebra/pager";

const out = await deliverNotice(
  "TEAM CHANNEL WIRED · Vertebra",
  "The pager now fans out to both destinations: this operator chat AND the Operations team group — one gated send path, two honest labels (telegram + telegram-group). Live-intent replies, convoy touches, autonomous-send notices, and crit escalations all arrive exactly like this.",
);
console.log("attempted:", out.attempted.join(", ") || "none");
console.log("delivered:", out.delivered.join(", ") || "none");
if (out.refused.length) console.log("refused:", out.refused.join(" | "));
if (out.delivered.length < 2) process.exitCode = 1;
