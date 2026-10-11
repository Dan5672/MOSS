// Network UPS Tools: each UPS as a monitor (down on battery or low battery, degraded when its battery needs
// replacing), with charge, runtime, load and input voltage as readings. The latest readings are kept for the
// shutdown plan (ups-shutdown.ts), which acts when the battery runs low.
import type { ParsedAlert } from "../monitoring/webhooks.js";
import type { FeatureOutput, IntegrationDef } from "./types.js";

export interface UpsReading {
  name: string;
  description?: string;
  status: string;
  onBattery: boolean;
  lowBattery: boolean;
  replaceBattery: boolean;
  charge?: number;
  runtimeSeconds?: number;
  load?: number;
  inputVoltage?: number;
  manufacturer?: string;
  model?: string;
}

/** What the shutdown plan reads: the last readings and when they were taken. */
export interface UpsState {
  ups?: { at: string; readings: UpsReading[] };
}

const minutes = (s?: number) => (s === undefined ? undefined : Math.round(s / 6) / 10);

export function upsHealth(r: { ups: UpsReading[] }, now: Date): FeatureOutput {
  const alerts: ParsedAlert[] = r.ups.map((u) => {
    const values = Object.fromEntries(
      Object.entries({ charge: u.charge, runtimeMinutes: minutes(u.runtimeSeconds), load: u.load, inputVoltage: u.inputVoltage }).filter(([, v]) => typeof v === "number"),
    ) as Record<string, number>;
    const left = values.runtimeMinutes !== undefined ? `, about ${Math.round(values.runtimeMinutes)} min left` : "";
    const status = u.onBattery || u.lowBattery ? "down" : u.replaceBattery ? "degraded" : "up";
    const message = u.lowBattery
      ? `Low battery: ${u.charge ?? "?"}%${left}`
      : u.onBattery
        ? `On battery: ${u.charge ?? "?"}%${left}`
        : u.replaceBattery
          ? "On mains, but the battery needs replacing"
          : `On mains, battery ${u.charge ?? "?"}%, load ${u.load ?? "?"}%`;
    return { key: `ups:${u.name}`, name: `UPS ${u.description || u.name}`, status, message, ...(u.charge !== undefined ? { value: u.charge, unit: "%" } : {}), values };
  });
  const out = r.ups.filter((u) => u.onBattery);
  return {
    alerts,
    summary: out.length ? `${out.map((u) => u.name).join(", ")} on battery` : `${r.ups.length} UPS(es) on mains`,
    state: { ups: { at: now.toISOString(), readings: r.ups } } satisfies UpsState,
  };
}

export const NUT: IntegrationDef = {
  key: "nut",
  name: "UPS (Network UPS Tools)",
  description: "Know the moment the power goes, watch the battery, and shut your home lab down in order before it runs out.",
  plan: "free",
  connection: {
    defaultPort: 3493,
    tls: false,
    user: { label: "upsd user (if it needs one)" },
    hint: "The machine running upsd (the NUT server your UPS is plugged into, or a NAS that shares its UPS over NUT), port 3493. It must allow MOSS's address (LISTEN in upsd.conf).",
  },
  credential: {
    secretName: "nut-password",
    type: "password",
    arg: "password",
    optional: true,
    label: "upsd password",
    hint: "Only if upsd asks for one (a monitoring user from upsd.users).",
    tools: ["nut_status"],
  },
  test: {
    op: "status",
    describe: (r) => {
      const ups = (r as { ups: UpsReading[] }).ups;
      return `Connected to upsd: ${ups.map((u) => `${u.name} (${[u.manufacturer, u.model].filter(Boolean).join(" ") || "UPS"}) ${u.onBattery ? "on battery" : "on mains"}, ${u.charge ?? "?"}%`).join("; ")}.`;
    },
  },
  ops: { status: { tool: "nut_status" } },
  features: [
    {
      key: "health",
      label: "UPS checks",
      description: "Every minute: each UPS on mains or on battery, its charge, runtime left, load and input voltage. On battery is an incident; a battery needing replacement is degraded.",
      everyMs: 60_000,
      op: "status",
      apply: (r, { now }) => upsHealth(r as { ups: UpsReading[] }, now),
    },
  ],
  agentTools: ["nut_status"],
};
