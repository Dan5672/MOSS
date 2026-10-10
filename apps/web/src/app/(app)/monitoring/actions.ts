"use server";

import {
  checkMonitorNow,
  createMonitor,
  createMonitorSource,
  deleteMonitor,
  deleteMonitorSource,
  monitorTargetWarning,
  setMonitorEnabled,
  setMonitorSourceEnabled,
  updateMonitor,
} from "@moss/core";
import { redirect } from "next/navigation";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";

const int = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const decimal = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : Number(v));
const list = (v: string | undefined) =>
  v
    ?.split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);

/** "agent:<id>" | "user:<id>" | "" -> responder fields. */
function parseResponder(value: string | undefined) {
  if (!value) return { responderAgentId: null, responderUserId: null };
  const [kind, id] = value.split(":");
  const uuid = z.uuid().parse(id);
  return kind === "agent" ? { responderAgentId: uuid, responderUserId: null } : { responderAgentId: null, responderUserId: uuid };
}

/** Form fields -> monitor input. Only the fields that apply to the kind are sent; core validates the rest. */
function monitorFromForm(form: FormData) {
  const f = formObject(form);
  const kind = f.kind as "ping" | "tcp" | "http" | "tls" | "dns" | "snmp" | "host" | "ha_sensor";
  const config: Record<string, unknown> = {};
  if (kind === "tcp" || kind === "http" || kind === "tls") config.port = int(f.port);
  if (kind === "http") {
    config.scheme = f.scheme ?? "http";
    config.path = f.path;
    config.keyword = f.keyword;
    config.expectStatus = list(f.expectStatus);
  }
  if (kind === "http" || kind === "tls") config.verifyTls = f.verifyTls === "on";
  if (kind === "tls") config.warnDays = int(f.warnDays);
  if (kind === "dns") {
    config.recordType = f.recordType ?? "A";
    config.expectAnswer = f.expectAnswer;
  }
  if (kind === "snmp" || kind === "host") config.secret = f.secret;
  if (kind === "snmp") {
    if (f.snmpMode === "oid") {
      config.oid = f.oid;
      config.counter = f.counter === "on";
    } else config.ifIndex = int(f.ifIndex);
  }
  if (kind === "host") {
    config.user = f.user;
    config.port = int(f.port);
    config.hostKeySha256 = f.hostKeySha256;
  }
  const metricKind = kind === "snmp" || kind === "host" || kind === "ha_sensor";
  if (metricKind) {
    config.metric = f.metric;
    config.unit = f.unit;
    for (const k of ["warnAbove", "critAbove", "warnBelow", "critBelow"]) config[k] = decimal(f[k]);
  } else config.degradedMs = int(f.degradedMs);
  config.incidentOnDegraded = f.incidentOnDegraded === "on";
  for (const k of Object.keys(config)) if (config[k] === undefined || (Array.isArray(config[k]) && !(config[k] as unknown[]).length)) delete config[k];
  return {
    name: f.name ?? "",
    kind,
    target: f.target ?? "",
    config,
    assetId: f.assetId ?? null,
    intervalSeconds: int(f.intervalSeconds),
    failureThreshold: int(f.failureThreshold),
    recoveryThreshold: int(f.recoveryThreshold),
    priority: f.priority as "P1" | "P2" | "P3" | "P4" | undefined,
    autoResolve: f.autoResolve === "on",
    ...parseResponder(f.responder),
  };
}

export async function createMonitorAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("monitoring.manage");
    const m = await createMonitor(db(), user.orgId, monitorFromForm(form), { type: "user", id: user.id });
    // The detail page warns if the target is outside the allowed networks.
    redirect(`/monitoring/${m.id}`);
  });
}

export async function updateMonitorAction(monitorId: string, external: boolean, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("monitoring.manage");
    const input = external
      ? (() => {
          const f = formObject(form);
          return { name: f.name, assetId: f.assetId ?? null, priority: f.priority, autoResolve: f.autoResolve === "on", ...parseResponder(f.responder) };
        })()
      : monitorFromForm(form);
    const m = await updateMonitor(db(), user.orgId, monitorId, input, { type: "user", id: user.id });
    const warning = await monitorTargetWarning(db(), user.orgId, m.target, m.kind);
    return warning ? `Saved. Warning: ${warning}, so checks will be refused until it is allowed.` : "Monitor saved.";
  });
}

export async function setMonitorEnabledAction(monitorId: string, enabled: boolean): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("monitoring.manage");
    await setMonitorEnabled(db(), user.orgId, monitorId, enabled, { type: "user", id: user.id });
    return enabled ? "Monitor resumed." : "Monitor paused.";
  });
}

export async function checkNowAction(monitorId: string): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("monitoring.manage");
    await checkMonitorNow(db(), user.orgId, monitorId);
    return "Check queued. Results appear within a few seconds.";
  });
}

export async function deleteMonitorAction(monitorId: string): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("monitoring.manage");
    await deleteMonitor(db(), user.orgId, monitorId, { type: "user", id: user.id });
    redirect("/monitoring");
  });
}

export type SourceCreated = (NonNullable<ActionState> & { token?: string; sourceId?: string }) | undefined;

export async function createSourceAction(_: SourceCreated, form: FormData): Promise<SourceCreated> {
  let created: { token: string; sourceId: string } | undefined;
  const state = await act(async () => {
    const user = await requirePermission("monitoring.manage");
    const f = formObject(form);
    const { source, token } = await createMonitorSource(
      db(),
      user.orgId,
      { name: f.name ?? "", kind: f.kind ?? "", defaultPriority: (f.defaultPriority ?? "P3") as "P3", defaultResponderAgentId: f.defaultResponderAgentId ?? null },
      { type: "user", id: user.id },
    );
    created = { token, sourceId: source.id };
    return `Created ${source.name}. Copy the token now: it is not shown again.`;
  });
  return { ...state, ...created };
}

export async function setSourceEnabledAction(sourceId: string, enabled: boolean): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("monitoring.manage");
    await setMonitorSourceEnabled(db(), user.orgId, sourceId, enabled, { type: "user", id: user.id });
    return enabled ? "Source enabled." : "Source disabled: its webhooks are now refused.";
  });
}

export async function deleteSourceAction(sourceId: string): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("monitoring.manage");
    await deleteMonitorSource(db(), user.orgId, sourceId, { type: "user", id: user.id });
    return "Source deleted, with the monitors it created.";
  });
}
