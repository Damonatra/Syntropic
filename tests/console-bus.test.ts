import { describe, expect, it } from "vitest";
import { CONSOLE_REFRESH_EVENT, onConsoleRefresh, requestConsoleRefresh } from "../src/lib/vertebra/console-bus";

/**
 * The bus is browser-orchestra, lib-tested: in the Node test environment
 * there is no window, so dispatch must be an honest no-op and the
 * subscription a no-op unsubscribe — never a throw, never a silent fire.
 */
describe("console refresh bus", () => {
  it("is a no-op without a window (SSR / Node)", () => {
    expect(() => requestConsoleRefresh("test")).not.toThrow();
    let fired = 0;
    const off = onConsoleRefresh(() => {
      fired += 1;
    });
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
    requestConsoleRefresh("test-again");
    expect(fired).toBe(0); // nothing fired without a window — and the sub is detached anyway
  });

  it("carries one shared event name for the cockpit and every panel", () => {
    expect(CONSOLE_REFRESH_EVENT).toBe("vertebra:console-refresh");
  });
});
