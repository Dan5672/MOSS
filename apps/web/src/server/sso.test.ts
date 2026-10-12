import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({ db: () => null }));
const { pickOrigin } = await import("./sso");

describe("sign-in links", () => {
  it("come from the request, unless MOSS_PUBLIC_URL fixes the addresses", () => {
    expect(pickOrigin("https://moss.lan", [])).toBe("https://moss.lan");
    const fixed = ["https://moss.lan", "https://moss.tail1234.ts.net"];
    expect(pickOrigin("https://moss.tail1234.ts.net", fixed)).toBe("https://moss.tail1234.ts.net");
    // A forged X-Forwarded-Host can't send the sign-in somewhere else.
    expect(pickOrigin("https://evil.example", fixed)).toBe("https://moss.lan");
  });
});
