// Moss's generated reference: facts about MOSS taken from the code itself (settings, tools, skills,
// templates, roles), so they can't drift from what the running version actually does. Written to
// library/docs/reference.md by `corepack pnpm gen:reference`; a test fails if the committed copy is stale.
import { BUILT_IN_ROLES, BUILT_IN_TOOLS, SETTING_DEFAULTS, SETTING_DESCRIPTIONS } from "@moss/core";
import type { Library } from "./library.js";
import { PLATFORM_TOOLS } from "./platform-tools.js";

const cell = (s: string) => s.replace(/\|/g, "\|").replace(/\s+/g, " ").trim();

export function buildReference(lib: Library): string {
  const out: string[] = [
    "# Reference (generated)",
    "Generated from MOSS's code by `corepack pnpm gen:reference`. Don't edit by hand.",
    "",
    "## Settings",
    "Stored per install; most are switched on the Settings page.",
    "",
    "| Setting | Default | What it does |",
    "| --- | --- | --- |",
  ];
  for (const [key, value] of Object.entries(SETTING_DEFAULTS).sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`| ${key} | ${JSON.stringify(value)} | ${cell(SETTING_DESCRIPTIONS[key as keyof typeof SETTING_DESCRIPTIONS])} |`);
  }

  // One short section per tool and skill, so a search finds the one asked about rather than one long list.
  const grantedBy = (tool: string) => [...lib.skills.values()].filter((s) => s.tools.includes(tool)).map((s) => s.name);
  for (const t of [...BUILT_IN_TOOLS.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))) {
    const skills = grantedBy(t.manifest.name);
    out.push(
      "",
      `## Tool ${t.manifest.name}`,
      `A network tool (${t.manifest.class === "write" ? "changes things: only through an approved change" : t.manifest.class}), run by the toolbox through the policy gate. ${cell(t.description)}`,
      `Granted by: ${skills.join(", ") || "no skill (grant it on Agents → Tool access)"}.`,
    );
  }
  for (const t of [...PLATFORM_TOOLS].sort((a, b) => a.name.localeCompare(b.name))) {
    const skills = grantedBy(t.name);
    out.push("", `## Tool ${t.name}`, `A MOSS tool (works on MOSS itself; needs the ${t.permission} permission). ${cell(t.description)}`, `Granted by: ${skills.join(", ") || "no skill"}.`);
  }
  for (const s of [...lib.skills.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(
      "",
      `## Skill ${s.name}`,
      `${s.core ? "Core: built into every agent (except Moss)." : "Added per agent."} Key ${s.key}. ${cell(s.description)}`,
      `Tools: ${s.tools.join(", ") || "none"}.`,
    );
  }

  out.push("", "## Agent templates", "", "| Template | Default name | Skills (besides the core ones) |", "| --- | --- | --- |");
  for (const t of [...lib.templates.values()].sort((a, b) => a.title.localeCompare(b.title))) {
    out.push(`| ${t.title} | ${t.defaultName} | ${t.skills.join(", ") || "none"} |`);
  }

  out.push("", "## Roles", "Built-in roles and their permissions (Settings → Users).", "");
  for (const [key, role] of Object.entries(BUILT_IN_ROLES)) {
    out.push(`- ${role.name} (${key}): ${[...role.permissions].sort().join(", ")}`);
  }
  return `${out.join("\n")}\n`;
}
