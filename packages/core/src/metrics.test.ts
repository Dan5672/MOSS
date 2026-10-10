// Metric monitors: rates from counters, thresholds, and how values read.
import { describe, expect, it } from "vitest";
import { applyThresholds, counterRates, formatMetric } from "./monitoring/metrics.js";

describe("metric monitors", () => {
  it("turns counters into per-second rates, skipping ones that went backwards", () => {
    const at = "2030-01-01T00:00:00Z";
    const now = new Date("2030-01-01T00:01:00Z");
    expect(counterRates({ a: 100, b: 500, c: 9 }, at, { a: 700, b: 100, d: 5 }, now)).toEqual({ a: 10 });
    expect(counterRates(undefined, undefined, { a: 1 }, now)).toEqual({});
    expect(counterRates({ a: 1 }, "2029-12-01T00:00:00Z", { a: 2 }, now)).toEqual({}); // too old to mean anything
  });

  it("applies warning and critical thresholds to the chosen value", () => {
    const ok = { ok: true, message: "fine", value: 50, values: { load1: 3.5 }, unit: "%" };
    expect(applyThresholds(ok, {})).toBe(ok);
    expect(applyThresholds(ok, { warnAbove: 40, critAbove: 80 })).toMatchObject({ ok: true, degraded: true, message: "50% is above 40" });
    expect(applyThresholds(ok, { critAbove: 45 })).toMatchObject({ ok: false, message: "50% is above 45" });
    expect(applyThresholds(ok, { metric: "load1", critBelow: 4 })).toMatchObject({ ok: false, message: "load1 3.5 is below 4" });
    expect(applyThresholds({ ...ok, value: null }, { critAbove: 1 })).toMatchObject({ ok: true }); // no value yet
    expect(applyThresholds({ ok: false, message: "down", value: 99 }, { critAbove: 1 })).toMatchObject({ message: "down" });
  });

  it("formats values with their units", () => {
    expect(formatMetric(2_345_678, "bps")).toBe("2.3 Mbps");
    expect(formatMetric(950, "bps")).toBe("950 bps");
    expect(formatMetric(87.256, "%")).toBe("87.26%");
    expect(formatMetric(21.5, "°C")).toBe("21.5 °C");
    expect(formatMetric(null)).toBe("no value");
  });
});
