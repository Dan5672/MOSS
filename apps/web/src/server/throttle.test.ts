import { describe, expect, it } from "vitest";
import { createThrottle } from "./throttle";

describe("attempt throttle", () => {
  it("counts each attempt as it is taken, so a burst can't share one count", () => {
    const t = createThrottle(5, 1000);
    const burst = Array.from({ length: 20 }, () => t.take("k", 0));
    expect(burst.filter(Boolean)).toHaveLength(5);
    expect(t.take("other", 0)).toBe(true);
  });

  it("refunds, clears, and opens again after the window", () => {
    const t = createThrottle(2, 1000);
    t.take("k", 0);
    t.take("k", 0);
    expect(t.take("k", 0)).toBe(false);
    t.refund("k");
    expect(t.take("k", 0)).toBe(true);
    t.clear("k");
    expect(t.take("k", 0)).toBe(true);
    expect(t.take("k", 0)).toBe(true);
    expect(t.take("k", 0)).toBe(false);
    expect(t.take("k", 1000)).toBe(true);
  });
});
