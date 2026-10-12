// `@moss/agent/library` is what the gate loads. Everything it reaches must stay off the runtime, the queue and the
// model clients: walk its relative imports and check every package they pull in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const ALLOWED = new Set(["@moss/core", "@moss/db", "drizzle-orm", "yaml", "zod"]);

function reach(file: string, seen = new Set<string>(), packages = new Set<string>()) {
  if (seen.has(file)) return { seen, packages };
  seen.add(file);
  const source = readFileSync(join(SRC, file), "utf8");
  for (const [, spec] of source.matchAll(/^(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)) {
    if (spec!.startsWith("./")) reach(spec!.slice(2).replace(/\.js$/, ".ts"), seen, packages);
    else if (!spec!.startsWith("node:")) packages.add(spec!);
  }
  return { seen, packages };
}

describe("@moss/agent/library", () => {
  it("reaches only the library and lifecycle modules and their allowed packages", () => {
    const { seen, packages } = reach("library-sync.ts");
    expect([...seen].sort()).toEqual(["library-sync.ts", "library.ts", "lifecycle.ts"]);
    expect([...packages].filter((p) => !ALLOWED.has(p))).toEqual([]);
  });
});
