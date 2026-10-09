// Moss's tools: MOSS's own documentation, and how this install is configured (read-only, never a secret's
// value), plus ask_moss, which other agents use to consult Moss and get its answer in the same run.
import { BUILT_IN_TOOLS, getSetting, loadHomeAssistant, SETTING_DEFAULTS, type SettingKey } from "@moss/core";
import {
  agentRuns,
  agents,
  agentSchedules,
  agentSkills,
  auditLog,
  monitors,
  monitorSources,
  models,
  secretGrants,
  secrets,
  skills,
} from "@moss/db";
import { and, count, desc, eq, gte, ne } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MOSS_TEMPLATE } from "./lifecycle.js";
import type { PlatformTool } from "./platform-tools.js";

export interface DocSection {
  doc: string;
  section: string;
  text: string;
}

// Built with path.join rather than new URL(...): the web app bundles this package, and its bundler treats a
// relative URL as an asset to resolve at build time. The docs are only read at run time, by the worker.
const libraryDir = () => process.env.MOSS_LIBRARY_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "library");
let docsCache: Promise<DocSection[]> | null = null;

/** MOSS's documentation, split into its "## " sections. Read once per process. */
export function loadDocs(dir = join(libraryDir(), "docs")): Promise<DocSection[]> {
  docsCache ??= (async () => {
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".md")).sort();
    const out: DocSection[] = [];
    for (const f of files) {
      const text = await readFile(join(dir, f), "utf8");
      const doc = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? f;
      for (const part of text.split(/^## /m).slice(1)) {
        const [heading, ...body] = part.split("\n");
        out.push({ doc, section: heading!.trim(), text: body.join("\n").trim() });
      }
    }
    return out;
  })();
  return docsCache;
}

const STOP_WORDS = new Set("the and for you your are was were what why how does did can cant can't not with this that from into have has had when where which who its it's mean means about there their they them".split(" "));

/** Sections ranked by the query's words they contain, rarer words counting more, title matches double. */
export function searchDocs(sections: DocSection[], query: string, limit = 5): DocSection[] {
  const words = [...new Set(query.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w)))];
  if (!words.length) return sections.slice(0, limit);
  const lower = sections.map((s) => ({ title: `${s.doc} ${s.section}`.toLowerCase(), body: s.text.toLowerCase() }));
  // Inverse document frequency: a word in every section says little; one in a single section says a lot.
  const weight = new Map(words.map((w) => [w, Math.log((sections.length + 1) / (lower.filter((l) => l.title.includes(w) || l.body.includes(w)).length + 1)) + 0.1]));
  return sections
    .map((s, i) => {
      const { title, body } = lower[i]!;
      const score = words.reduce((n, w) => n + weight.get(w)! * ((title.includes(w) ? 2 : 0) + (body.includes(w) ? 1 : 0)), 0);
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

const CONFIG_SECTIONS = ["settings", "modules", "agents", "monitoring", "denials", "health"] as const;

export const MOSS_TOOLS: PlatformTool[] = [
  {
    name: "moss_docs_search",
    description:
      "Search MOSS's own documentation: how it works, its pages and settings, the policy gate and its denial codes, change " +
      "management, secrets, chat, modules and troubleshooting. Search 'tools' to list every network tool and which skills grant it.",
    permission: "agents.read",
    args: z.object({ query: z.string().min(1).max(200) }),
    run: async ({ db, orgId }, { query }) => {
      if (/\btools?\b/i.test(query) && /\b(list|which|all|catalog|grant)/i.test(query)) {
        const rows = await db.select({ key: skills.key, tools: skills.toolGrants }).from(skills).where(eq(skills.orgId, orgId));
        return {
          tools: [...BUILT_IN_TOOLS.values()].map((d) => ({
            name: d.manifest.name,
            class: d.manifest.class,
            description: d.description.slice(0, 200),
            grantedBy: rows.filter((r) => r.tools.includes(d.manifest.name)).map((r) => r.key),
          })),
        };
      }
      const found = searchDocs(await loadDocs(), query);
      return found.length ? { sections: found } : { sections: [], note: "Nothing in the docs matches. Try other words, or say the docs don't cover it." };
    },
  },
  {
    name: "moss_config_read",
    description:
      "Read how this MOSS install is set up (read-only; never secret values): settings, modules, agents (skills, " +
      "tools, secrets, recurring tasks), monitoring (monitors and webhook sources), recent policy denials, or health " +
      "(recent failed runs and agents over budget).",
    permission: "agents.read",
    args: z.object({ section: z.enum(CONFIG_SECTIONS) }),
    run: async ({ db, orgId }, { section }) => {
      switch (section) {
        case "settings": {
          const keys = Object.keys(SETTING_DEFAULTS) as SettingKey[];
          return Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await getSetting(db, orgId, k)] as const)));
        }
        case "modules": {
          const ha = await loadHomeAssistant(db, orgId);
          const [token] = await db.select({ hosts: secrets.allowedHosts }).from(secrets).where(and(eq(secrets.orgId, orgId), eq(secrets.name, "homeassistant-token")));
          return { homeAssistant: { enabled: ha.enabled, config: ha.config, tokenStored: !!token, tokenHosts: token?.hosts ?? [], state: ha.state } };
        }
        case "agents": {
          const team = await db
            .select({ id: agents.id, name: agents.name, title: agents.title, status: agents.status, pausedReason: agents.pausedReason, model: models.displayName })
            .from(agents)
            .leftJoin(models, eq(models.id, agents.modelId))
            .where(and(eq(agents.orgId, orgId), ne(agents.status, "fired")));
          return Promise.all(
            team.map(async (a) => ({
              ...a,
              skills: (await db.select({ key: skills.key, tools: skills.toolGrants }).from(agentSkills).innerJoin(skills, eq(skills.id, agentSkills.skillId)).where(eq(agentSkills.agentId, a.id))).map(
                (s) => ({ skill: s.key, tools: s.tools }),
              ),
              secrets: (
                await db
                  .select({ name: secrets.name, type: secrets.type, username: secrets.username, hosts: secrets.allowedHosts, tools: secrets.allowedTools })
                  .from(secretGrants)
                  .innerJoin(secrets, eq(secrets.id, secretGrants.secretId))
                  .where(eq(secretGrants.agentId, a.id))
              ).map((s) => ({ handle: `secret:${s.name}`, type: s.type, username: s.username, hosts: s.hosts, tools: s.tools })),
              recurringTasks: await db.select({ cron: agentSchedules.cron, task: agentSchedules.task, enabled: agentSchedules.enabled }).from(agentSchedules).where(eq(agentSchedules.agentId, a.id)),
            })),
          );
        }
        case "monitoring": {
          const [byState, sources] = await Promise.all([
            db.select({ state: monitors.state, n: count() }).from(monitors).where(eq(monitors.orgId, orgId)).groupBy(monitors.state),
            db
              .select({ name: monitorSources.name, kind: monitorSources.kind, enabled: monitorSources.enabled, lastReceivedAt: monitorSources.lastReceivedAt })
              .from(monitorSources)
              .where(eq(monitorSources.orgId, orgId)),
          ]);
          const down = await db.select({ name: monitors.name, target: monitors.target, lastResult: monitors.lastResult }).from(monitors).where(and(eq(monitors.orgId, orgId), eq(monitors.state, "down")));
          return { monitorsByState: Object.fromEntries(byState.map((r) => [r.state, r.n])), down, webhookSources: sources };
        }
        case "denials": {
          const rows = await db
            .select({ at: auditLog.createdAt, agentId: auditLog.actorId, tool: auditLog.targetId, details: auditLog.details })
            .from(auditLog)
            .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "tool.denied")))
            .orderBy(desc(auditLog.id))
            .limit(20);
          const names = new Map((await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.orgId, orgId))).map((a) => [a.id, a.name]));
          return rows.map((r) => {
            const d = r.details as { code?: string; reason?: string };
            return { at: r.at.toISOString(), agent: names.get(r.agentId ?? "") ?? r.agentId, tool: r.tool, code: d.code, reason: d.reason };
          });
        }
        case "health": {
          const since = new Date(Date.now() - 7 * 86_400_000);
          const failed = await db
            .select({ agent: agents.name, trigger: agentRuns.trigger, status: agentRuns.status, summary: agentRuns.summary, startedAt: agentRuns.startedAt })
            .from(agentRuns)
            .innerJoin(agents, eq(agents.id, agentRuns.agentId))
            .where(and(eq(agentRuns.orgId, orgId), ne(agentRuns.status, "succeeded"), ne(agentRuns.status, "running"), gte(agentRuns.startedAt, since)))
            .orderBy(desc(agentRuns.startedAt))
            .limit(15);
          const paused = await db.select({ name: agents.name, reason: agents.pausedReason }).from(agents).where(and(eq(agents.orgId, orgId), eq(agents.status, "paused")));
          return { failedRunsLastWeek: failed.map((f) => ({ ...f, summary: f.summary?.slice(0, 300) ?? null, startedAt: f.startedAt.toISOString() })), pausedAgents: paused, killSwitch: await getSetting(db, orgId, "agents.kill_switch") };
        }
      }
    },
  },
  {
    name: "ask_moss",
    description:
      "Ask Moss, the expert on MOSS itself, a question about MOSS: why a tool call was denied, how a setting or module works, " +
      "how to do something in MOSS. You get Moss's answer back. Not for questions about the network.",
    permission: "agents.read",
    args: z.object({ question: z.string().min(5).max(2000) }),
    run: async ({ db, orgId, agentId, consult }, { question }) => {
      const [moss] = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), eq(agents.templateKey, MOSS_TEMPLATE), ne(agents.status, "fired")));
      if (!moss) return { error: "There's no Moss on this install yet (it's hired once there is a model)." };
      if (moss.id === agentId) return { error: "You are Moss." };
      if (moss.status !== "active") return { error: "Moss is paused." };
      if (!consult) return { error: "Consulting Moss isn't available here." };
      const [asker] = await db.select({ name: agents.name, title: agents.title }).from(agents).where(eq(agents.id, agentId));
      const answer = await consult(
        moss.id,
        `${asker?.name ?? "Another agent"} (${asker?.title ?? "an agent"}) asks you about MOSS:\n\n${question}\n\n` +
          "Look it up in MOSS's docs and this install's configuration, and answer briefly and specifically. Your final message is your answer.",
      );
      return answer.status === "succeeded" ? { answer: answer.summary } : { error: `Moss couldn't answer (${answer.status}): ${answer.summary.slice(0, 300)}` };
    },
  },
];
