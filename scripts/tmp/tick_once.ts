/**
 * One-off: live sequence tick with the fast lane armed — the operator
 * wants to see the real autonomous-send notice land in Telegram.
 * Prints the bounded TickOutcome; no secrets cross stdout.
 */
import { runSequenceTick } from "../../src/lib/vertebra/tick";

const out = await runSequenceTick();
console.log(JSON.stringify(out, null, 1).slice(0, 1600));
