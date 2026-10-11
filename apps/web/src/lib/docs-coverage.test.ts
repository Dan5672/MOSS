// Moss answers from library/docs. These tests fail when the app gains a page, a tab or an integration that
// the docs don't mention, so Moss can't fall behind what people see.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MODULE_NAMES } from "@moss/core";
import { describe, expect, it } from "vitest";
import { ACTIVITY_TABS } from "@/app/(app)/runs/tabs";
import { AGENTS_TABS } from "@/app/(app)/agents/tabs";
import { MONITORING_TABS } from "@/app/(app)/monitoring/tabs";
import { SETTINGS_TABS } from "@/app/(app)/settings/tabs";
import { NAV_ITEMS } from "@/components/nav";

const DOCS = fileURLToPath(new URL("../../../../library/docs", import.meta.url));

async function allDocs() {
  const files = (await readdir(DOCS)).filter((f) => f.endsWith(".md"));
  return (await Promise.all(files.map((f) => readFile(`${DOCS}/${f}`, "utf8")))).join("\n");
}

describe("Moss's docs cover the app", () => {
  it("names every sidebar item and every tab in the overview", async () => {
    const overview = await readFile(`${DOCS}/overview.md`, "utf8");
    const missing = [...NAV_ITEMS, ...AGENTS_TABS, ...MONITORING_TABS, ...SETTINGS_TABS, ...ACTIVITY_TABS].map((i) => i.label).filter((l) => !overview.includes(l));
    expect(missing, "Add these to library/docs/overview.md (## Pages)").toEqual([]);
  });

  it("describes every integration", async () => {
    const docs = await allDocs();
    for (const name of Object.values(MODULE_NAMES)) expect(docs, `Describe the ${name} integration in library/docs`).toContain(`## The ${name} integration`);
  });
});
