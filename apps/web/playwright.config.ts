// End-to-end tests: a real browser against `next start`, backed by a fresh test database.
// Needs MOSS_TEST_DATABASE_URL (the suite uses <db>_web_e2e). Build first: `pnpm build`.
import { defineConfig, devices } from "@playwright/test";

const base = process.env.MOSS_TEST_DATABASE_URL;
if (!base) throw new Error("Set MOSS_TEST_DATABASE_URL to run the e2e tests");
const dbUrl = new URL(base);
dbUrl.pathname = `${dbUrl.pathname}_web_e2e`;
const PORT = 3107;
export const E2E_GATE_PORT = 3108;
export const E2E_WEB_TOKEN = "e2e-web-token-for-the-stand-in-gate-0000";
/** The stand-in gate's master key (hex), so tests can seed encrypted rows it can open. */
export const E2E_MASTER_KEY_HEX = "22".repeat(32);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: dbUrl.toString(),
      MOSS_APP_KEY: "11".repeat(32),
      WEB_TOKEN: E2E_WEB_TOKEN,
      // Stand-in for the gate's secrets API, started by global-setup.
      GATE_URL: `http://127.0.0.1:${E2E_GATE_PORT}`,
      MOSS_LIBRARY_DIR: "../../library",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});

export const E2E_DATABASE_URL = dbUrl.toString();
