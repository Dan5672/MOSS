import { describe, expect, it } from "vitest";
import { layoutDependencies } from "./dependency-map";

const n = (id: string, parentId: string | null = null) => ({ id, parentId, name: id });
const at = (r: ReturnType<typeof layoutDependencies>, id: string) => r.placed.find((p) => p.node.id === id);

describe("layoutDependencies", () => {
  it("puts a host first and its VMs beside it, centred on them", () => {
    const r = layoutDependencies([n("vm2", "pve"), n("pve"), n("vm1", "pve"), n("vm3", "pve"), n("alone")]);
    expect(r).toMatchObject({ rows: 3, depth: 1 });
    expect(at(r, "pve")).toMatchObject({ depth: 0, row: 1 });
    expect(["vm1", "vm2", "vm3"].map((id) => at(r, id)?.row)).toEqual([0, 1, 2]);
    expect(at(r, "alone")).toBeUndefined(); // no dependency either way
  });

  it("handles deeper trees, several roots, a missing parent and a loop", () => {
    const r = layoutDependencies([n("switch"), n("pve", "switch"), n("vm", "pve"), n("nas"), n("plex", "nas"), n("orphan", "gone"), n("a", "b"), n("b", "a")]);
    expect(at(r, "vm")).toMatchObject({ depth: 2 });
    expect(at(r, "orphan")).toBeUndefined(); // its parent was deleted: it's on its own now
    expect(r.placed.map((p) => p.node.id).sort()).toEqual(["a", "b", "nas", "plex", "pve", "switch", "vm"]);
    expect(new Set(r.placed.map((p) => `${p.depth}:${p.row}`)).size).toBe(r.placed.length); // no overlaps
  });
});
