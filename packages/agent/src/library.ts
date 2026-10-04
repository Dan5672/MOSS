// Loads the prewritten skill and agent-template library (library/skills, library/templates)
// and syncs built-in skills into the database.
import { skills, type Database } from "@moss/db";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const KEY = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "keys are lowercase-kebab-case");

const skillFrontmatter = z.object({
  key: KEY,
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().default("1.0.0"),
  tools: z.array(z.string()).default([]),
});

export interface SkillDefinition extends z.infer<typeof skillFrontmatter> {
  instructions: string;
}

export const templateSchema = z.object({
  key: KEY,
  title: z.string().min(1),
  defaultName: z.string().min(1),
  description: z.string().min(1),
  suggestedModel: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  maxStepsPerRun: z.number().int().min(1).max(200).default(25),
  skills: z.array(KEY).default([]),
  reportsTo: KEY.nullable().default(null),
  systemPrompt: z.string().min(1),
  schedules: z.array(z.object({ cron: z.string().min(9), task: z.string().min(1) })).default([]),
});

export type AgentTemplate = z.infer<typeof templateSchema>;

/** Parses a SKILL.md file: YAML frontmatter between --- lines, then the instructions body. */
export function parseSkillMarkdown(text: string, source = "SKILL.md"): SkillDefinition {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${source}: missing YAML frontmatter`);
  const meta = skillFrontmatter.safeParse(parseYaml(m[1]!));
  if (!meta.success) throw new Error(`${source}: ${z.prettifyError(meta.error)}`);
  const instructions = m[2]!.trim();
  if (!instructions) throw new Error(`${source}: skill has no instructions`);
  return { ...meta.data, instructions };
}

export function parseTemplateYaml(text: string, source = "template"): AgentTemplate {
  const res = templateSchema.safeParse(parseYaml(text));
  if (!res.success) throw new Error(`${source}: ${z.prettifyError(res.error)}`);
  return res.data;
}

export interface Library {
  skills: Map<string, SkillDefinition>;
  templates: Map<string, AgentTemplate>;
}

export async function loadLibrary(dir: string): Promise<Library> {
  const lib: Library = { skills: new Map(), templates: new Map() };

  const skillDirs = await readdir(join(dir, "skills"), { withFileTypes: true });
  for (const d of skillDirs.filter((e) => e.isDirectory())) {
    const path = join(dir, "skills", d.name, "SKILL.md");
    const skill = parseSkillMarkdown(await readFile(path, "utf8"), path);
    if (lib.skills.has(skill.key)) throw new Error(`Duplicate skill key ${skill.key}`);
    lib.skills.set(skill.key, skill);
  }

  const templateFiles = (await readdir(join(dir, "templates"))).filter((f) => /\.ya?ml$/.test(f));
  for (const f of templateFiles) {
    const path = join(dir, "templates", f);
    const template = parseTemplateYaml(await readFile(path, "utf8"), path);
    if (lib.templates.has(template.key)) throw new Error(`Duplicate template key ${template.key}`);
    lib.templates.set(template.key, template);
  }

  for (const t of lib.templates.values()) {
    for (const s of t.skills) if (!lib.skills.has(s)) throw new Error(`Template ${t.key} references unknown skill ${s}`);
    if (t.reportsTo && !lib.templates.has(t.reportsTo)) throw new Error(`Template ${t.key} reports to unknown template ${t.reportsTo}`);
  }
  return lib;
}

/** Upserts built-in skills for an org. User-created skills (builtIn = false) are never touched. */
export async function syncBuiltInSkills(db: Database, orgId: string, defs: Iterable<SkillDefinition>) {
  for (const s of defs) {
    const values = {
      name: s.name,
      description: s.description,
      version: s.version,
      instructions: s.instructions,
      toolGrants: s.tools,
      builtIn: true,
      updatedAt: new Date(),
    };
    await db
      .insert(skills)
      .values({ orgId, key: s.key, ...values })
      .onConflictDoUpdate({ target: [skills.orgId, skills.key], set: values });
  }
}
