// The data behind the Home Assistant integration: one snapshot of MOSS's state, a feed of things that
// happened (for Home Assistant's event entities), and a calendar of change windows and recurring tasks.
import "server-only";
import { changeRef, getSetting, incidentRef, listMonitors } from "@moss/core";
import { agentRuns, agents, agentSchedules, assets, budgets, changeRequests, configBackups, events, incidents, monitors, tokenUsage } from "@moss/db";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { spritePixels } from "@/components/mascots";
import { agentGlow, agentMascot } from "@/lib/agent-look";
import { cronOccurrences } from "@/lib/cron";
import { describeCron } from "@/lib/schedule";
import { db } from "./db";
import { basement } from "./queries";

/** CSS colour variables used by mascots, as the plain colours an image outside the app needs. */
const CSS_COLOURS: Record<string, string> = { "--phosphor": "#4dff9a", "--amber": "#ffb547", "--signal": "#5ad8ff", "--glow": "#4dff9a", "--alarm": "#ff6b4a" };
const plain = (c: string) => c.replace(/^var\((--[a-z-]+)\)$/, (_, v: string) => CSS_COLOURS[v] ?? "#4dff9a");

/** An agent's mascot as a small SVG data URL, for entity pictures and the Basement card. */
export function mascotDataUrl(a: { mascot: string | null; mascotGlow: string | null; templateKey: string | null }) {
  const glow = plain(agentGlow(a));
  // One path per colour, with runs of pixels merged, keeps it small (Home Assistant stores attributes up to 16 KB).
  const byColour = new Map<string, Map<number, number[]>>();
  for (const p of spritePixels(agentMascot(a), glow)) {
    const rows = byColour.get(plain(p.color)) ?? new Map<number, number[]>();
    rows.set(p.y, [...(rows.get(p.y) ?? []), p.x]);
    byColour.set(plain(p.color), rows);
  }
  const paths = [...byColour]
    .map(([colour, rows]) => {
      let d = "";
      for (const [y, xs] of rows) {
        const sorted = [...new Set(xs)].sort((m, n) => m - n);
        for (let i = 0; i < sorted.length; ) {
          let j = i;
          while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
          d += `M${sorted[i]} ${y}h${j - i + 1}v1h-${j - i + 1}z`;
          i = j + 1;
        }
      }
      return `<path fill="${colour}" d="${d}"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${paths}</svg>`;
  return { picture: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, glow };
}

const OPEN = ["new", "in_progress", "on_hold"] as const;
const PRIORITY_RANK: Record<string, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfMonth(d = new Date()) {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

export async function haSnapshot(orgId: string) {
  const d = db();
  const today = startOfDay();
  const [b, agentRows, monitorRows, openIncidents, [pending], killSwitch, quietUntil, allowResume, [spentToday], [spentMonth], budgetRows, runsToday, costsToday, lastRuns, tasks, [securityOpen], backups] =
    await Promise.all([
      basement(orgId),
      d.select().from(agents).where(and(eq(agents.orgId, orgId), ne(agents.status, "fired"))).orderBy(asc(agents.hiredAt)),
      listMonitors(d, orgId),
      d
        .select({ i: incidents, agentName: agents.name })
        .from(incidents)
        .leftJoin(agents, eq(agents.id, incidents.assignedAgentId))
        .where(and(eq(incidents.orgId, orgId), inArray(incidents.status, [...OPEN])))
        .orderBy(desc(incidents.createdAt)),
      d.select({ n: count() }).from(changeRequests).where(and(eq(changeRequests.orgId, orgId), eq(changeRequests.status, "submitted"))),
      getSetting(d, orgId, "agents.kill_switch"),
      getSetting(d, orgId, "monitoring.quiet_until"),
      getSetting(d, orgId, "homeassistant.allow_resume"),
      d.select({ usd: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)` }).from(tokenUsage).where(and(eq(tokenUsage.orgId, orgId), gte(tokenUsage.createdAt, today))),
      d.select({ usd: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)` }).from(tokenUsage).where(and(eq(tokenUsage.orgId, orgId), gte(tokenUsage.createdAt, startOfMonth()))),
      d.select().from(budgets).where(and(eq(budgets.orgId, orgId), isNull(budgets.agentId), eq(budgets.unit, "usd"))),
      d.select({ agentId: agentRuns.agentId, n: count() }).from(agentRuns).where(and(eq(agentRuns.orgId, orgId), gte(agentRuns.startedAt, today))).groupBy(agentRuns.agentId),
      d
        .select({ agentId: tokenUsage.agentId, usd: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)` })
        .from(tokenUsage)
        .where(and(eq(tokenUsage.orgId, orgId), gte(tokenUsage.createdAt, today)))
        .groupBy(tokenUsage.agentId),
      d
        .selectDistinctOn([agentRuns.agentId], { agentId: agentRuns.agentId, status: agentRuns.status, task: agentRuns.task, summary: agentRuns.summary, endedAt: agentRuns.endedAt })
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, orgId), ne(agentRuns.status, "running")))
        .orderBy(agentRuns.agentId, desc(agentRuns.startedAt)),
      d
        .select({ s: agentSchedules, agentName: agents.name })
        .from(agentSchedules)
        .innerJoin(agents, eq(agents.id, agentSchedules.agentId))
        .where(and(eq(agentSchedules.orgId, orgId), ne(agents.status, "fired")))
        .orderBy(asc(agents.name)),
      d.select({ n: count() }).from(incidents).where(and(eq(incidents.orgId, orgId), eq(incidents.type, "security"), inArray(incidents.status, [...OPEN]))),
      d
        .selectDistinctOn([configBackups.target], { target: configBackups.target, at: configBackups.createdAt })
        .from(configBackups)
        .where(eq(configBackups.orgId, orgId))
        .orderBy(configBackups.target, desc(configBackups.createdAt)),
    ]);

  const running = await d
    .selectDistinctOn([agentRuns.agentId], { agentId: agentRuns.agentId, task: agentRuns.task, trigger: agentRuns.trigger, startedAt: agentRuns.startedAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, "running")))
    .orderBy(agentRuns.agentId, desc(agentRuns.startedAt));

  const agentList = agentRows.map((a) => {
    const run = running.find((r) => r.agentId === a.id);
    const last = lastRuns.find((r) => r.agentId === a.id);
    const status = a.status === "paused" ? "paused" : run || a.id === b.responderId ? "working" : "on_break";
    return {
      id: a.id,
      name: a.name,
      title: a.title,
      templateKey: a.templateKey,
      status,
      task: run?.task ?? null,
      trigger: run?.trigger ?? null,
      since: run?.startedAt ?? null,
      lastRun: last ? { status: last.status, endedAt: last.endedAt, summary: (last.summary ?? "").slice(0, 300), task: (last.task ?? "").slice(0, 200) } : null,
      runsToday: runsToday.find((r) => r.agentId === a.id)?.n ?? 0,
      costTodayUsd: Number(costsToday.find((c) => c.agentId === a.id)?.usd ?? 0),
      ...mascotDataUrl(a),
    };
  });

  const highest = [...openIncidents].sort((x, y) => PRIORITY_RANK[x.i.priority]! - PRIORITY_RANK[y.i.priority]!)[0];
  const newest = openIncidents[0];
  const monthlyLimit = budgetRows.find((r) => r.period === "month");
  const dailyLimit = budgetRows.find((r) => r.period === "day");
  const quiet = quietUntil && new Date(quietUntil).getTime() > Date.now() ? quietUntil : null;

  return {
    moss: { version: process.env.MOSS_RELEASE ?? "dev" },
    summary: {
      openIncidents: openIncidents.length,
      highestPriority: highest?.i.priority ?? null,
      newestIncident: newest ? { id: newest.i.id, ref: incidentRef(newest.i.number), title: newest.i.title, priority: newest.i.priority, assignee: newest.agentName } : null,
      monitorsDown: monitorRows.filter((m) => m.state === "down").length,
      monitorsDegraded: monitorRows.filter((m) => m.state === "degraded").length,
      downNames: monitorRows.filter((m) => m.state === "down").map((m) => m.name),
      changesPending: pending?.n ?? 0,
      agentsWorking: agentList.filter((a) => a.status === "working").length,
      agentsOnBreak: agentList.filter((a) => a.status === "on_break").length,
      agentsPaused: agentList.filter((a) => a.status === "paused").length,
      killSwitch,
      quietUntil: quiet,
      allowResume,
    },
    budget: {
      todayUsd: Number(spentToday?.usd ?? 0),
      monthUsd: Number(spentMonth?.usd ?? 0),
      dailyLimitUsd: dailyLimit ? Number(dailyLimit.hardLimit) : null,
      monthlyLimitUsd: monthlyLimit ? Number(monthlyLimit.hardLimit) : null,
    },
    agents: agentList,
    monitors: monitorRows.map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      state: m.state,
      enabled: m.enabled,
      uptime24h: m.uptime24h,
      lastCheckAt: m.lastCheckAt,
      message: m.lastResult?.message ?? null,
      asset: m.assetName,
    })),
    tasks: tasks.map(({ s, agentName }) => ({ id: s.id, agentId: s.agentId, agentName, task: s.task, cron: s.cron, when: describeCron(s.cron), enabled: s.enabled })),
    security: { openSecurityIncidents: securityOpen?.n ?? 0, backups: backups.map((x) => ({ target: x.target, at: x.at })) },
    basement: { responderId: b.responderId, down: b.down },
  };
}

// --- Events -----------------------------------------------------------------------------------------

const FEED_TYPES = ["incident.created", "incident.resolved", "monitor.down", "monitor.up", "change.submitted", "asset.discovered", "run.finished", "agent.asked"];

/** What happened since a cursor, described for Home Assistant. With no cursor, just the current cursor. */
export async function haEvents(orgId: string, after: number | null) {
  const d = db();
  if (after === null) {
    const [last] = await d.select({ id: sql<number>`coalesce(max(${events.id}), 0)` }).from(events).where(eq(events.orgId, orgId));
    return { cursor: Number(last?.id ?? 0), events: [] };
  }
  const rows = await d
    .select()
    .from(events)
    .where(and(eq(events.orgId, orgId), gt(events.id, after), inArray(events.type, FEED_TYPES)))
    .orderBy(asc(events.id))
    .limit(100);
  const out = [];
  for (const e of rows) {
    const p = e.payload as Record<string, string>;
    const base = { id: e.id, at: e.createdAt };
    if (e.type === "incident.created" || e.type === "incident.resolved") {
      const [row] = await d.select({ i: incidents, agentName: agents.name }).from(incidents).leftJoin(agents, eq(agents.id, incidents.assignedAgentId)).where(eq(incidents.id, p.incidentId!));
      if (row) out.push({ ...base, entity: "incidents", type: e.type === "incident.created" ? "opened" : "resolved", data: { id: row.i.id, ref: incidentRef(row.i.number), title: row.i.title, priority: row.i.priority, assignee: row.agentName } });
    } else if (e.type === "monitor.down" || e.type === "monitor.up") {
      const [m] = await d.select({ id: monitors.id, name: monitors.name, message: sql<string | null>`${monitors.lastResult}->>'message'` }).from(monitors).where(eq(monitors.id, p.monitorId!));
      if (m) out.push({ ...base, entity: "monitors", type: e.type === "monitor.down" ? "down" : "recovered", data: { id: m.id, name: m.name, message: m.message } });
    } else if (e.type === "change.submitted") {
      const [c] = await d.select().from(changeRequests).where(eq(changeRequests.id, p.changeId!));
      if (c && c.status === "submitted") out.push({ ...base, entity: "changes", type: "waiting_for_approval", data: { id: c.id, ref: changeRef(c.number), title: c.title, risk: c.risk } });
    } else if (e.type === "asset.discovered") {
      const [a] = await d.select().from(assets).where(eq(assets.id, p.assetId!));
      if (a) out.push({ ...base, entity: "devices", type: "new_device", data: { id: a.id, name: a.name, ip: a.primaryIp, mac: a.primaryMac, vendor: a.vendor } });
    } else if (e.type === "run.finished") {
      const [a] = await d.select({ name: agents.name }).from(agents).where(eq(agents.id, p.agentId!));
      const [r] = await d.select({ task: agentRuns.task, summary: agentRuns.summary }).from(agentRuns).where(eq(agentRuns.id, p.runId!));
      if (a) out.push({ ...base, entity: "agents", type: "run_finished", data: { agent: a.name, agentId: p.agentId, status: p.status, task: (r?.task ?? "").slice(0, 200), summary: (r?.summary ?? "").slice(0, 300) } });
    } else if (e.type === "agent.asked") {
      const [a] = await d.select({ name: agents.name }).from(agents).where(eq(agents.id, p.agentId!));
      if (a) out.push({ ...base, entity: "agents", type: "question", data: { agent: a.name, agentId: p.agentId, question: p.question } });
    }
  }
  return { cursor: rows.length ? Number(rows.at(-1)!.id) : after, events: out };
}

// --- Calendar ---------------------------------------------------------------------------------------

export async function haCalendar(orgId: string, start: Date, end: Date) {
  const d = db();
  const [changes, tasks] = await Promise.all([
    d
      .select()
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.orgId, orgId),
          notInArray(changeRequests.status, ["rejected", "cancelled", "draft"]),
          lte(changeRequests.windowStart, end),
          or(gte(changeRequests.windowEnd, start), isNull(changeRequests.windowEnd)),
        ),
      ),
    d
      .select({ s: agentSchedules, agentName: agents.name })
      .from(agentSchedules)
      .innerJoin(agents, eq(agents.id, agentSchedules.agentId))
      .where(and(eq(agentSchedules.orgId, orgId), eq(agentSchedules.enabled, true), eq(agents.status, "active"))),
  ]);
  const items = changes
    .filter((c) => c.windowStart)
    .map((c) => ({
      uid: `change-${c.id}`,
      summary: `${changeRef(c.number)}: ${c.title}`,
      description: `Change window (${c.status.replace("_", " ")}, ${c.risk} risk).`,
      start: c.windowStart!,
      end: c.windowEnd ?? new Date(c.windowStart!.getTime() + 60 * 60_000),
    }));
  for (const { s, agentName } of tasks) {
    for (const at of cronOccurrences(s.cron, start, end, 100)) {
      items.push({ uid: `task-${s.id}-${at.getTime()}`, summary: `${agentName}: ${s.task.slice(0, 80)}`, description: s.task, start: at, end: new Date(at.getTime() + 15 * 60_000) });
    }
  }
  return items.sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, 500);
}
