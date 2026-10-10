import { describe, expect, it } from "vitest";
import { GLOW, isMascot, MASCOT_IDS, MASCOTS, spritePixels } from "./index";

describe("mascot registry", () => {
  it.each(MASCOT_IDS)("%s: 16 rows of 16 characters, all in its palette, with a working blink rule", (id) => {
    const sprite = MASCOTS[id];
    expect(sprite.id).toBe(id);
    expect(sprite.label.length).toBeGreaterThan(0);
    expect(sprite.map).toHaveLength(16);
    const pal = sprite.pal as Record<string, string>;
    for (const row of sprite.map) {
      expect(row).toHaveLength(16);
      for (const ch of row) expect(ch === "." || ch in pal, `"${ch}" in ${id}`).toBe(true);
    }
    expect(Object.values(pal)).toContain(GLOW);
    const blink = sprite.blink as { row: number; from: string; to: string };
    expect(blink.to in pal).toBe(true);
    // Blinking changes at least one pixel, and nothing outside the blink row.
    const open = spritePixels(id, "#00ff00");
    const shut = spritePixels(id, "#00ff00", true);
    const changed = open.filter((p, i) => p.color !== shut[i]!.color);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((p) => p.y === blink.row)).toBe(true);
  });

  it("only accepts registered mascots", () => {
    expect(isMascot("monitor")).toBe(true);
    expect(isMascot("toString")).toBe(false);
    expect(isMascot("removed-mascot")).toBe(false);
    expect(isMascot(undefined)).toBe(false);
  });
});
