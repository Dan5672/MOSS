// Unit tests for the web app (the browser tests are Playwright, in e2e/).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"], exclude: ["**/node_modules/**", ".next/**"] },
});
