import { BUILT_IN_TOOLS } from "@moss/tools";
import { describe, expect, it } from "vitest";
import { groupTools, TOOL_GROUPS, toolGroup } from "./tool-groups";

describe("tool groups", () => {
  it("every built-in tool is in exactly one group, and every grouped name is a real tool", () => {
    for (const name of BUILT_IN_TOOLS.keys()) expect(toolGroup(name), name).not.toBe("other");
    const grouped = TOOL_GROUPS.flatMap((g) => [...g.tools]);
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const name of grouped) expect(BUILT_IN_TOOLS.has(name), name).toBe(true);
  });

  it("splits a list into groups in display order, skipping empty ones", () => {
    const groups = groupTools(["config_backup", "ping", "kb_search", "my_plex"], (t) => (t === "kb_search" ? "moss" : t === "my_plex" ? "custom" : toolGroup(t)));
    expect(groups.map((g) => [g.label, g.items])).toEqual([
      ["Probes and monitoring", ["ping"]],
      ["Backups", ["config_backup"]],
      ["MOSS tools", ["kb_search"]],
      ["Custom tools", ["my_plex"]],
    ]);
  });
});
