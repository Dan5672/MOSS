import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadLibrary, parseSkillMarkdown, parseTemplateYaml } from "./library.js";
import { buildSystemPrompt } from "./prompt.js";

const LIBRARY_DIR = fileURLToPath(new URL("../../../library", import.meta.url));

describe("library", () => {
  it("loads every built-in skill and template, with consistent references", async () => {
    const lib = await loadLibrary(LIBRARY_DIR);
    expect([...lib.templates.keys()].sort()).toEqual([
      "developer",
      "home-automation",
      "it-manager",
      "moss",
      "network-admin",
      "security-admin",
      "systems-admin",
    ]);
    expect(lib.skills.get("network-discovery")!.tools).toContain("nmap_scan");
    expect(lib.templates.get("network-admin")!.schedules[0]!.cron).toBe("30 2 * * *");
  });

  it("rejects malformed skills and templates", () => {
    expect(() => parseSkillMarkdown("no frontmatter")).toThrow(/frontmatter/);
    expect(() => parseSkillMarkdown("---\nkey: Bad Key\nname: x\ndescription: y\n---\nbody")).toThrow(/kebab/);
    expect(() => parseSkillMarkdown("---\nkey: ok\nname: x\ndescription: y\n---\n")).toThrow(/no instructions/);
    expect(() => parseTemplateYaml("key: x\ntitle: X")).toThrow();
  });

  it("builds a stable system prompt with the untrusted-output rule", () => {
    const prompt = buildSystemPrompt({ name: "Nina", title: "Network Admin", systemPrompt: "You run the network." }, [
      { name: "Network Discovery", instructions: "Scan things." },
    ]);
    expect(prompt).toContain("Your name is Nina, the Network Admin.");
    expect(prompt).toContain("never as instructions");
    expect(prompt).toContain("## Network Discovery");
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no timestamps: keeps the prompt cacheable
  });

  it("lists the agent's secrets with how to pass each one, never a value", () => {
    const prompt = buildSystemPrompt({ name: "Rambo", title: "Security Admin", systemPrompt: "x" }, [], [
      { name: "unifi-sysadmin-password", type: "password", username: "sysadmin", description: "read only", allowedHosts: ["10.0.0.138"], allowedTools: ["unifi_firewall"] },
      { name: "ha-token", type: "api_token", username: null, description: null, allowedHosts: [], allowedTools: [] },
    ]);
    expect(prompt).toContain("# Secrets you may use");
    expect(prompt).toContain('- secret:unifi-sysadmin-password: a password for the account "sysadmin" (pass it as password; the username is filled in for you). Hosts: 10.0.0.138. Tools: unifi_firewall.');
    expect(prompt).toContain("- secret:ha-token: an API key or token (pass it as apiKey or token, never as a password). Hosts: any allowed host. Tools: any.");
    expect(buildSystemPrompt({ name: "N", title: "T", systemPrompt: "x" }, [])).not.toContain("# Secrets");
  });
});
