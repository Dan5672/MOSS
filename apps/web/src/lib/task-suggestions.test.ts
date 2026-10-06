import { describe, expect, it } from "vitest";
import { taskSuggestions } from "./task-suggestions";

describe("task suggestions", () => {
  it("puts the agent's own incidents and down monitors first, then skill tasks", () => {
    const s = taskSuggestions({
      // Skills arrive in any order; ideas follow the fixed priority.
      skills: ["asset-inventory", "monitoring-response", "network-discovery"],
      incidents: [{ ref: "INC-12", title: "NAS unreachable" }],
      downMonitors: [{ name: "nas web" }],
    });
    expect(s).toEqual([
      "Work INC-12: NAS unreachable. Find the cause and propose a fix.",
      'The monitor "nas web" is down. Find out why.',
      "Discover devices on all allowed networks, then identify and classify any new or unidentified ones.",
    ]);
  });

  it("only mentions down monitors to agents that respond to monitoring", () => {
    const s = taskSuggestions({ skills: ["server-checks"], incidents: [], downMonitors: [{ name: "nas web" }] });
    expect(s.join(" ")).not.toContain("nas web");
    expect(s[0]).toContain("disk space");
  });

  it("always offers three, even for an agent with no skills", () => {
    expect(taskSuggestions({ skills: [], incidents: [], downMonitors: [] })).toHaveLength(3);
    expect(new Set(taskSuggestions({ skills: ["team-memory"], incidents: [], downMonitors: [] })).size).toBe(3);
  });
});
