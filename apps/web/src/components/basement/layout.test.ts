import { describe, expect, it } from "vitest";
import { assign, DESKS, FIRE_MAPS, FIRE_PALETTE, hash, ledColours, shortName, SPOTS } from "./layout";

describe("basement layout", () => {
  it("hashes ids with FNV-1a (seed 0)", () => {
    // Reference FNV-1a 32-bit of "a" is 0xe40c292c; Math.imul works in signed 32-bit, then abs().
    expect(hash("a")).toBe(Math.abs(0xe40c292c | 0));
  });

  it("seats ids stably, first come first served, and leaves extras out", () => {
    const ids = ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"];
    const seats = assign(ids, DESKS.length);
    expect(assign(ids, DESKS.length)).toEqual(seats);
    expect(Object.keys(seats)).toEqual(ids.slice(0, DESKS.length));
    expect(new Set(Object.values(seats)).size).toBe(DESKS.length);
    // Whoever goes first always gets a seat, whatever its hash.
    for (const first of ids) expect(assign([first, ...ids.filter((i) => i !== first)], 2)[first]).toBeDefined();
  });

  it("may seat people differently on another visit (another seed)", () => {
    const ids = ["mgr", "sys1", "net1"];
    const layouts = new Set([0, 1, 2, 3, 4, 5].map((seed) => JSON.stringify(assign(ids, DESKS.length, seed))));
    expect(layouts.size).toBeGreaterThan(1);
  });

  it("has well-formed slots and sprites", () => {
    expect(DESKS).toHaveLength(6);
    expect(SPOTS).toHaveLength(6);
    for (const frame of FIRE_MAPS) {
      expect(frame).toHaveLength(8);
      for (const row of frame) {
        expect(row).toHaveLength(6);
        for (const ch of row) expect(FIRE_PALETTE[ch]).toBeDefined();
      }
    }
  });

  it("turns about 12% of LEDs red only during an alarm, the same way every time", () => {
    const red = (alarm: boolean) => ledColours(alarm).racks.flatMap((r) => r.units.flat()).filter((l) => l.c === "#ff3b2a").length;
    expect(red(false)).toBe(0);
    expect(red(true)).toBeGreaterThan(0);
    expect(red(true) / (3 * 12 * 4)).toBeLessThan(0.25);
    expect(ledColours(true)).toEqual(ledColours(true));
  });

  it("makes short nameplates", () => {
    expect(shortName("Nina")).toBe("NINA");
    expect(shortName("Lab Netadmin")).toBe("LAB");
    expect(shortName("Christopherson")).toBe("CHRISTOP");
  });
});
