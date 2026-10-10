// Monitor state machine. Pure: given the monitor's counters and one check result, decide the
// next state. Thresholds stop one dropped packet from paging anyone.
import type { monitors } from "@moss/db";

export type MonitorState = (typeof monitors.$inferSelect)["state"];

export interface CheckResult {
  ok: boolean;
  /** Up, but slow or close to failing (e.g. certificate expiring soon). */
  degraded?: boolean;
  latencyMs?: number | null;
  message: string;
  policyDenied?: boolean;
  /** Metric monitors: the main value, every value by name, its unit, and raw counters for the next rate. */
  value?: number | null;
  values?: Record<string, number>;
  unit?: string;
  counters?: Record<string, number>;
}

export interface MonitorCounters {
  state: MonitorState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  failureThreshold: number;
  recoveryThreshold: number;
}

export interface Transition {
  state: MonitorState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  changed: boolean;
}

export function nextState(m: MonitorCounters, r: CheckResult): Transition {
  const failures = r.ok ? 0 : m.consecutiveFailures + 1;
  const successes = r.ok ? m.consecutiveSuccesses + 1 : 0;
  let state = m.state;

  if (!r.ok) {
    // A policy denial is not flaky: the check can never pass, so say so immediately.
    if (state !== "down" && (failures >= Math.max(1, m.failureThreshold) || r.policyDenied)) state = "down";
  } else {
    const healthy: MonitorState = r.degraded ? "degraded" : "up";
    if (state === "down") {
      if (successes >= Math.max(1, m.recoveryThreshold)) state = healthy;
    } else {
      // pending, up, degraded (and paused, which only reaches here if a stale check lands): follow the result.
      state = healthy;
    }
  }
  return { state, consecutiveFailures: failures, consecutiveSuccesses: successes, changed: state !== m.state };
}

/** Flapping: too many state changes in a short window. Incidents stay open and comments stop until it settles. */
export const FLAP_WINDOW_MS = 30 * 60_000;
export const FLAP_CHANGES = 4;

export function isFlapping(recentChangeTimes: Date[], now: Date): boolean {
  return recentChangeTimes.filter((t) => now.getTime() - t.getTime() <= FLAP_WINDOW_MS).length >= FLAP_CHANGES;
}
