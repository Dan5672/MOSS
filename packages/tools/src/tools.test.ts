import { describe, expect, it } from "vitest";
import { BUILT_IN_TOOLS, nmapScan, parseToolArgs, ping, toolInputSchema } from "./index.js";

describe("tool catalog", () => {
  it("validates and applies defaults", () => {
    expect(parseToolArgs(ping, { target: "192.168.1.1" })).toEqual({ ok: true, args: { target: "192.168.1.1", count: 3 } });
  });

  it("rejects option injection, hostnames and unknown arguments", () => {
    for (const targets of [["-oN/etc/passwd"], ["--script=evil"], ["nas.local"], ["1.2.3.4 -p-"], []]) {
      expect(parseToolArgs(nmapScan, { targets, profile: "ping" }).ok).toBe(false);
    }
    expect(parseToolArgs(nmapScan, { targets: ["10.0.0.1"], profile: "ping", extraFlags: "-A" }).ok).toBe(false);
    expect(parseToolArgs(nmapScan, { targets: ["10.0.0.1"], profile: "aggressive" }).ok).toBe(false);
  });

  it("produces JSON schemas for every tool", () => {
    for (const def of BUILT_IN_TOOLS.values()) {
      const schema = toolInputSchema(def);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema.$schema).toBeUndefined();
    }
  });
});
