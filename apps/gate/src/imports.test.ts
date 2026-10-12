// The gate holds the master key, so it loads as little as it can. From the agent package it may use only the
// library sync entry (`@moss/agent/library`), never the root, which brings in the runtime, the queue and the model clients.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

describe("gate imports", () => {
  it("never imports the root of @moss/agent", () => {
    const offenders = readdirSync(SRC)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => /from\s+["']@moss\/agent["']/.test(readFileSync(join(SRC, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
