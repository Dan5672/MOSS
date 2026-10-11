// Comparing the running MOSS with the newest release.
import { describe, expect, it } from "vitest";
import { compareRelease, newestRelease, parseMossVersion } from "./services/releases.js";

describe("MOSS releases", () => {
  it("reads release and development versions", () => {
    expect(parseMossVersion("v0.2.0")).toEqual({ parts: [0, 2, 0], ahead: 0 });
    expect(parseMossVersion("v0.1.1-88-g741af22")).toEqual({ parts: [0, 1, 1], ahead: 88 });
    expect(parseMossVersion("dev")).toBeNull();
  });

  it("picks the newest plain release, by number not by text", () => {
    expect(newestRelease(["v0.9.0", "v0.10.0", "v0.10.0-rc1", "nightly", "v0.2.3"])).toBe("v0.10.0");
    expect(newestRelease([])).toBeNull();
  });

  it("says whether there's an update", () => {
    const tags = ["v0.1.0", "v0.2.0"];
    expect(compareRelease("v0.1.0", tags)).toEqual({ running: "v0.1.0", latest: "v0.2.0", status: "update", url: "https://github.com/Dan5672/MOSS/releases/tag/v0.2.0" });
    expect(compareRelease("v0.1.0-40-gabc1234", tags).status).toBe("update");
    expect(compareRelease("v0.2.0", tags).status).toBe("current");
    expect(compareRelease("v0.2.0-3-gabc1234", tags).status).toBe("ahead");
    expect(compareRelease("dev", tags).status).toBe("unknown");
    expect(compareRelease("v0.2.0", []).status).toBe("unknown");
  });
});
