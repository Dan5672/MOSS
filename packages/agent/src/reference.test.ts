import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadLibrary } from "./library.js";
import { buildReference } from "./reference.js";

const LIBRARY_DIR = fileURLToPath(new URL("../../../library", import.meta.url));

describe("Moss's generated reference", () => {
  it("matches the code. If this fails, run: corepack pnpm gen:reference", async () => {
    const committed = await readFile(`${LIBRARY_DIR}/docs/reference.md`, "utf8").catch(() => "");
    expect(committed.replace(/\r\n/g, "\n")).toBe(buildReference(await loadLibrary(LIBRARY_DIR)));
  });
});
