// Metric monitors (SNMP, host stats, Home Assistant sensors): turning counters into rates, and thresholds
// into states. Pure, so the gate's checks and the tests share them.
import type { MonitorConfig } from "@moss/db";
import type { CheckResult } from "./state.js";

/** Per-second rates for counters that both checks have; a counter that went backwards (wrapped, rebooted) is skipped. */
export function counterRates(prev: Record<string, number> | undefined, prevAt: string | undefined, cur: Record<string, number>, now: Date): Record<string, number> {
  if (!prev || !prevAt) return {};
  const seconds = (now.getTime() - new Date(prevAt).getTime()) / 1000;
  if (!(seconds > 0) || seconds > 3 * 86_400) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(cur)) {
    const before = prev[k];
    if (typeof before === "number" && v >= before) out[k] = (v - before) / seconds;
  }
  return out;
}

/** "1.2 Mbps", "87 %", "21.5 °C". */
export function formatMetric(value: number | null | undefined, unit = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "no value";
  if (unit === "bps") {
    const steps = ["bps", "kbps", "Mbps", "Gbps", "Tbps"];
    let v = value;
    let i = 0;
    while (Math.abs(v) >= 1000 && i < steps.length - 1) (v /= 1000), i++;
    return `${v >= 100 || i === 0 ? Math.round(v) : Number(v.toFixed(1))} ${steps[i]}`;
  }
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  return unit ? `${rounded}${unit === "%" ? "" : " "}${unit}` : String(rounded);
}

/**
 * Applies a monitor's thresholds to a successful metric result: past a critical threshold it's a failure (down
 * after the usual number of checks), past a warning one it's degraded. No thresholds: the result stands.
 */
export function applyThresholds(result: CheckResult, c: MonitorConfig): CheckResult {
  if (!result.ok) return result;
  const name = c.metric;
  const value = name ? result.values?.[name] : result.value;
  // No value yet (a rate needs two checks) or none this time: nothing to judge.
  if (value === undefined || value === null) return result;
  const show = `${name ? `${name} ` : ""}${formatMetric(value, name ? "" : result.unit)}`;
  if (c.critAbove !== undefined && value > c.critAbove) return { ...result, ok: false, message: `${show} is above ${c.critAbove}` };
  if (c.critBelow !== undefined && value < c.critBelow) return { ...result, ok: false, message: `${show} is below ${c.critBelow}` };
  if (c.warnAbove !== undefined && value > c.warnAbove) return { ...result, degraded: true, message: `${show} is above ${c.warnAbove}` };
  if (c.warnBelow !== undefined && value < c.warnBelow) return { ...result, degraded: true, message: `${show} is below ${c.warnBelow}` };
  return result;
}

export function hasThresholds(c: MonitorConfig): boolean {
  return [c.warnAbove, c.critAbove, c.warnBelow, c.critBelow].some((v) => v !== undefined);
}

/** SNMP interface OIDs for one ifIndex: the 64-bit octet counters, error counters and status. */
export function interfaceOids(ifIndex: number) {
  return {
    inOctets: `1.3.6.1.2.1.31.1.1.1.6.${ifIndex}`,
    outOctets: `1.3.6.1.2.1.31.1.1.1.10.${ifIndex}`,
    inErrors: `1.3.6.1.2.1.2.2.1.14.${ifIndex}`,
    outErrors: `1.3.6.1.2.1.2.2.1.20.${ifIndex}`,
    status: `1.3.6.1.2.1.2.2.1.8.${ifIndex}`,
    name: `1.3.6.1.2.1.31.1.1.1.1.${ifIndex}`,
  };
}
