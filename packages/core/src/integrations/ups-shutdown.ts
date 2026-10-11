// The UPS shutdown plan: an ordered list of things to switch off (Proxmox guests, then Linux servers, the NAS last)
// when a UPS on battery runs low. The owner chooses how it runs:
//   "ask"  - MOSS raises the plan as a change and asks for approval (with buttons in Telegram or Discord);
//   "auto" - the plan was approved once in advance (with a fresh two-factor code) as a standard change, so MOSS
//            raises it already approved.
// Either way, the chosen agent carries it out step by step, and if the power comes back first MOSS cancels it.
import { changeRequests, type Database } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { cancelChange, createChangeRequest, upsertStandardTemplate } from "../services/changes.js";
import { loadModule } from "../services/modules.js";
import { getSetting, setSetting } from "../store/settings-store.js";
import { integrationArgs, loadIntegration } from "./config.js";
import type { UpsReading, UpsState } from "./nut.js";
import { PROXMOX } from "./proxmox.js";

export const UPS_TEMPLATE = "ups-shutdown";
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const upsStepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("proxmox"),
    label: z.string().trim().min(1).max(80),
    node: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/),
    kind: z.enum(["vm", "container"]),
    vmid: z.number().int().min(100).max(999_999_999),
  }),
  z.object({
    type: z.literal("ssh"),
    label: z.string().trim().min(1).max(80),
    target: z.string().regex(IPV4),
    user: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/),
    port: z.number().int().min(1).max(65535).default(22),
    secret: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  }),
]);
export type UpsStep = z.infer<typeof upsStepSchema>;

export const upsPlanSchema = z.object({
  mode: z.enum(["off", "ask", "auto"]).default("off"),
  agentId: z.uuid().optional(),
  /** Act when a UPS on battery has this many minutes left (or reports low battery). */
  runtimeMinutes: z.number().int().min(1).max(120).default(10),
  steps: z.array(upsStepSchema).max(20).default([]),
  /** "auto": who approved these exact steps, and when. */
  approval: z.object({ userId: z.uuid(), at: z.string(), hash: z.string() }).optional(),
});
export type UpsPlan = z.infer<typeof upsPlanSchema>;

export async function getUpsPlan(db: Database, orgId: string): Promise<UpsPlan> {
  const parsed = upsPlanSchema.safeParse(await getSetting(db, orgId, "ups.shutdown_plan"));
  return parsed.success ? parsed.data : upsPlanSchema.parse({});
}

export const stepsHash = (steps: UpsStep[]) => createHash("sha256").update(JSON.stringify(steps)).digest("hex").slice(0, 16);

/** Whether "auto" may run: approved, and nothing changed since. */
export const approvedInAdvance = (p: UpsPlan) => p.mode === "auto" && !!p.approval && p.approval.hash === stepsHash(p.steps);

/** The plan's tool calls: Proxmox guests through the Proxmox integration's connection, servers over SSH. */
export async function upsPlanCalls(db: Database, orgId: string, steps: UpsStep[]) {
  const pve = steps.some((s) => s.type === "proxmox") ? (await loadIntegration(db, orgId, PROXMOX)).config : null;
  return steps.map((s) => {
    if (s.type === "proxmox") {
      if (!pve?.host) throw new Error("Set up the Proxmox VE integration first: Proxmox steps use its connection.");
      return { tool: "proxmox_guest_power", args: { ...integrationArgs(PROXMOX, pve), node: s.node, kind: s.kind, vmid: s.vmid, action: "shutdown" } };
    }
    return { tool: "host_shutdown", args: { target: s.target, user: s.user, port: s.port, key: `secret:${s.secret}`, delayMinutes: 1 } };
  });
}

/** Saves the plan. Changing the steps withdraws an advance approval (the template is disabled until re-approved). */
export async function saveUpsPlan(db: Database, orgId: string, next: UpsPlan) {
  const before = await getUpsPlan(db, orgId);
  const plan = upsPlanSchema.parse({ ...next, approval: before.approval && before.approval.hash === stepsHash(next.steps) ? before.approval : undefined });
  await setSetting(db, orgId, "ups.shutdown_plan", plan);
  return plan;
}

/** Approves the plan in advance (the person's fresh two-factor code is checked by the caller): a standard change. */
export async function approveUpsPlan(db: Database, orgId: string, userId: string, now = new Date()) {
  const plan = await getUpsPlan(db, orgId);
  if (!plan.steps.length) throw new Error("Add the steps first.");
  await upsertStandardTemplate(
    db,
    orgId,
    {
      key: UPS_TEMPLATE,
      name: "Orderly shutdown in a power cut",
      description: `Shuts down, in order: ${plan.steps.map((s) => s.label).join(", ")}. Raised by MOSS when a UPS on battery has ${plan.runtimeMinutes} minutes or less left.`,
      risk: "medium",
      calls: await upsPlanCalls(db, orgId, plan.steps),
      params: {},
    },
    userId,
  );
  const approved = { ...plan, approval: { userId, at: now.toISOString(), hash: stepsHash(plan.steps) } };
  await setSetting(db, orgId, "ups.shutdown_plan", approved);
  return approved;
}

const ACTIVE = new Set(["draft", "submitted", "approved", "in_progress"]);

/**
 * Runs every minute while the UPS integration is on: raises the plan when a UPS on battery runs low, and cancels
 * it if the power comes back before it's done. Returns what it did, for the log.
 */
export async function upsShutdownTick(db: Database, orgId: string, now = new Date()): Promise<string | null> {
  const plan = await getUpsPlan(db, orgId);
  if (plan.mode === "off" || !plan.steps.length || !plan.agentId) return null;
  const state = (await loadModule(db, orgId, "nut")).state as UpsState;
  const fresh = state.ups && now.getTime() - Date.parse(state.ups.at) < 5 * 60_000 ? state.ups.readings : [];
  const onBattery = fresh.filter((u) => u.onBattery);
  const run = (await getSetting(db, orgId, "ups.shutdown_run")) as { changeId?: string };

  if (run.changeId) {
    const [c] = await db.select({ status: changeRequests.status }).from(changeRequests).where(and(eq(changeRequests.id, run.changeId), eq(changeRequests.orgId, orgId)));
    if (c && ACTIVE.has(c.status) && fresh.length && !onBattery.length) {
      try {
        await cancelChange(db, orgId, run.changeId, { type: "system", id: null }, "the power came back before the shutdown finished");
      } catch {
        // Already being carried out to the end; nothing to cancel.
      }
      await setSetting(db, orgId, "ups.shutdown_run", {});
      return "power back: shutdown cancelled";
    }
    if (!c || (!ACTIVE.has(c.status) && !onBattery.length)) await setSetting(db, orgId, "ups.shutdown_run", {});
    return null;
  }

  const low: UpsReading | undefined = onBattery.find((u) => u.lowBattery || (u.runtimeSeconds !== undefined && u.runtimeSeconds <= plan.runtimeMinutes * 60));
  if (!low) return null;
  const left = low.runtimeSeconds !== undefined ? `${Math.round(low.runtimeSeconds / 60)} minutes` : "little time";
  const common = {
    title: `Shut down for the power cut (UPS ${low.name}: ${left} left)`,
    description: `UPS ${low.name} is on battery at ${low.charge ?? "?"}% with ${left} left. The shutdown plan switches off, in order: ${plan.steps.map((s) => s.label).join(", ")}.`,
    verificationPlan: "After each step, check it went down (proxmox_status, or ping for a server) before the next. Stop if the power comes back.",
    rollbackPlan: "Switch them back on once the power is back (Proxmox guests with proxmox_guest_power start; servers by hand).",
    forAgentId: plan.agentId,
  };
  const change = approvedInAdvance(plan)
    ? await createChangeRequest(db, orgId, { ...common, type: "standard", standardTemplateKey: UPS_TEMPLATE }, { type: "system", id: null })
    : await createChangeRequest(db, orgId, { ...common, type: "normal", risk: "medium", plannedCalls: await upsPlanCalls(db, orgId, plan.steps) }, { type: "system", id: null });
  await setSetting(db, orgId, "ups.shutdown_run", { changeId: change.id, at: now.toISOString() });
  return approvedInAdvance(plan) ? "shutdown started (approved in advance)" : "shutdown raised for approval";
}
