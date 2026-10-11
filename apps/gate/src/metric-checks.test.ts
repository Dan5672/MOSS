// Home Assistant sensor states as monitor results.
import { describe, expect, it } from "vitest";
import { fmtBps, haSensorResult, type Monitor } from "./metric-checks.js";

const m = { target: "sensor.ups_load", config: {} } as Monitor;

describe("Home Assistant sensors", () => {
  it("reads numbers with their unit, on/off as 1/0, and treats unavailable as down", () => {
    expect(haSensorResult(m, { state: "23.5", unit: "%", name: "UPS load" })).toEqual({ ok: true, value: 23.5, values: { value: 23.5 }, unit: "%", message: "UPS load: 23.5 %" });
    expect(haSensorResult(m, { state: "off" })).toMatchObject({ ok: true, value: 0 });
    expect(haSensorResult(m, { state: "heat" })).toEqual({ ok: true, message: "sensor.ups_load: heat" });
    expect(haSensorResult(m, { state: "unavailable", name: "UPS load" })).toEqual({ ok: false, message: "UPS load is unavailable" });
    expect(haSensorResult(m, undefined)).toEqual({ ok: false, message: "Home Assistant has no sensor.ups_load" });
  });

  it("shows traffic in readable units", () => {
    expect(fmtBps(1_500_000)).toBe("1.5 Mbps");
    expect(fmtBps(undefined)).toBe("?");
  });
});
