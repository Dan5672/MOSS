import { describe, expect, it } from "vitest";
import { ipKey, readSort, sortHref, sortRows } from "./sort";

const rows = [
  { name: "nas", ip: "10.0.0.10", seen: new Date("2026-10-01") },
  { name: "Gateway", ip: "10.0.0.1", seen: null },
  { name: "printer", ip: "10.0.0.9", seen: new Date("2026-10-05") },
];
const by = { name: (r: (typeof rows)[number]) => r.name, ip: (r: (typeof rows)[number]) => ipKey(r.ip), seen: (r: (typeof rows)[number]) => r.seen };

describe("table sorting", () => {
  it("only accepts the page's own columns", () => {
    expect(readSort({ sort: "ip", dir: "desc" }, ["name", "ip"])).toEqual({ key: "ip", dir: "desc" });
    expect(readSort({ sort: "password", dir: "sideways" }, ["name", "ip"])).toEqual({ key: null, dir: "asc" });
  });

  it("sorts text case-insensitively, IPs numerically, and puts empty values last both ways", () => {
    expect(sortRows(rows, { key: "name", dir: "asc" }, by).map((r) => r.name)).toEqual(["Gateway", "nas", "printer"]);
    expect(sortRows(rows, { key: "ip", dir: "asc" }, by).map((r) => r.ip)).toEqual(["10.0.0.1", "10.0.0.9", "10.0.0.10"]);
    expect(sortRows(rows, { key: "seen", dir: "desc" }, by).map((r) => r.name)).toEqual(["printer", "nas", "Gateway"]);
    expect(sortRows(rows, { key: "seen", dir: "asc" }, by).map((r) => r.name)).toEqual(["nas", "printer", "Gateway"]);
    expect(sortRows(rows, { key: null, dir: "asc" }, by)).toEqual(rows);
  });

  it("links keep other parameters and flip the direction of the active column", () => {
    expect(sortHref("/assets", { q: "nas", sort: "ip", dir: "asc" }, { key: "ip", dir: "asc" }, "ip")).toBe("/assets?q=nas&sort=ip&dir=desc");
    expect(sortHref("/assets", { q: "nas" }, { key: "ip", dir: "desc" }, "name")).toBe("/assets?q=nas&sort=name&dir=asc");
  });
});
