import { describe, expect, it } from "vitest";
import { diffLines } from "./diff";

describe("diffLines", () => {
  it("marks removed, added and unchanged lines in order", () => {
    expect(diffLines("router\nswitch\nnas", "router\naccess point\nnas\nprinter")).toEqual([
      { kind: "same", text: "router" },
      { kind: "removed", text: "switch" },
      { kind: "added", text: "access point" },
      { kind: "same", text: "nas" },
      { kind: "added", text: "printer" },
    ]);
    expect(diffLines("same", "same")).toEqual([{ kind: "same", text: "same" }]);
  });
});
