import { describe, expect, it } from "vitest";
import { agentGlow, agentMascot, roleMascot } from "./agent-look";

describe("agent look", () => {
  it("defaults the mascot by role template", () => {
    expect(roleMascot("it-manager")).toBe("monitor");
    expect(roleMascot("systems-admin")).toBe("beanie");
    expect(roleMascot("network-admin")).toBe("headset");
    expect(roleMascot("security-admin")).toBe("nightshift");
    expect(roleMascot("developer")).toBe("monitor");
    expect(roleMascot(null)).toBe("monitor");
  });

  it("uses the stored mascot, falling back to the role default for unknown or removed ones", () => {
    expect(agentMascot({ mascot: "nightshift", templateKey: "it-manager" })).toBe("nightshift");
    expect(agentMascot({ mascot: null, templateKey: "systems-admin" })).toBe("beanie");
    expect(agentMascot({ mascot: "a-mascot-that-was-removed", templateKey: "network-admin" })).toBe("headset");
  });

  it("uses a stored glow only if it's a hex colour", () => {
    expect(agentGlow({ mascotGlow: "#ff7ad9", templateKey: "it-manager" })).toBe("#ff7ad9");
    expect(agentGlow({ mascotGlow: null, templateKey: "systems-admin" })).toBe("var(--amber)");
    expect(agentGlow({ mascotGlow: "red; background:url(x)", templateKey: "network-admin" })).toBe("var(--signal)");
  });
});
