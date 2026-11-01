/**
 * One-off: the honest single-channel probe — fires ONE real test page to
 * Telegram through the pager's own gated path (probePagerChannel).
 * Prints the verdict only; no key values cross stdout.
 */
import { probePagerChannel } from "../../src/lib/vertebra/pager";

const result = await probePagerChannel("telegram-pager");
console.log("probe ok:", result.ok);
console.log("detail:", result.detail);
if (!result.ok) process.exitCode = 1;
