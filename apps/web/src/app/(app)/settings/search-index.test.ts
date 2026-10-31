import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settingsIndex } from "./search-index";
import { searchSettings } from "./settings-search";

describe("settings search", () => {
  const index = settingsIndex();

  it("finds a setting by its name, its page or the words around it", () => {
    expect(searchSettings(index, "time zone")[0]?.href).toBe("/settings#time-zone");
    expect(searchSettings(index, "2fa")[0]?.label).toBe("Two-factor authentication");
    expect(searchSettings(index, "kill")[0]?.label).toBe("Kill switch");
    expect(searchSettings(index, "proxmox").map((e) => e.href)).toContain("/settings/integrations/proxmox");
  });

  it("puts matches in the label first, and finds nothing for nothing", () => {
    expect(searchSettings(index, "backups")[0]?.label).toMatch(/backups/i);
    expect(searchSettings(index, "  ")).toEqual([]);
    expect(searchSettings(index, "zzzz")).toEqual([]);
  });

  it("links every #section to a card that has that id", () => {
    const dir = __dirname;
    const source = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join(" ");
    const missing = index.filter((e) => e.href.startsWith("/settings") && e.href.includes("#")).filter((e) => !source.includes(`id="${e.href.split("#")[1]}"`));
    expect(missing).toEqual([]);
  });
});
