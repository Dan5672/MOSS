import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { bundledCatalog, fetchPublicText, isPrivateAddress } = await import("./tool-library");

const CATALOG = fileURLToPath(new URL("../../../../library/tool-catalog", import.meta.url));

describe("tools catalog", () => {
  it("every bundled definition is valid, read-only and has a unique key", async () => {
    const entries = await bundledCatalog(CATALOG);
    expect(entries.length).toBeGreaterThanOrEqual(10);
    for (const e of entries) expect(e.problem, `${e.ref}: ${e.problem}`).toBeUndefined();
    expect(entries.every((e) => e.kind === "read")).toBe(true);
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
  });

  it("knows which addresses are private or local", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "172.16.5.4", "192.168.50.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["1.1.1.1", "185.199.108.133", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("only fetches https from public addresses", async () => {
    await expect(fetchPublicText("http://example.com/x.yaml")).rejects.toThrow(/Only https/);
    await expect(fetchPublicText("https://127.0.0.1/x.yaml")).rejects.toThrow(/private or local/);
    await expect(fetchPublicText("https://user:pw@example.com/x.yaml")).rejects.toThrow(/credentials/);
  });
});
