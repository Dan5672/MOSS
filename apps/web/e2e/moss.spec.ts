// One story through the UI, in order: a new owner sets MOSS up and runs their IT department.
import { createChangeRequest, totpCode } from "@moss/core";
import { agents, createDb } from "@moss/db";
import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { E2E_DATABASE_URL } from "../playwright.config";

test.describe.configure({ mode: "serial" });

const OWNER = { name: "Dana Owner", email: "dana@home.test", password: "correct-horse-battery" };
const VIEWER = { name: "Vic Viewer", email: "vic@home.test", password: "viewer-password-123" };

let page: Page;
let ownerTotpSecret = "";
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

async function signIn(email: string, password: string, code?: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (code !== undefined) {
    await page.getByLabel("Authenticator code").fill(code);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}

async function signOut() {
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login$/);
}

test("first run: setup creates the owner and signs them in", async () => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel("Name for this network").fill("Home");
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByLabel("Confirm password").fill(OWNER.password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create and sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});

test("networks: allow a subnet", async () => {
  await page.getByRole("link", { name: "Networks" }).first().click();
  await page.getByLabel("CIDR").fill("192.168.50.7/24");
  await page.getByLabel("Name").fill("Home LAN");
  await page.getByRole("button", { name: "Save network" }).click();
  const row = page.getByRole("row", { name: /192\.168\.50\.0\/24/ });
  await expect(row).toContainText("allowed");
});

test("models: add a local provider and a model", async () => {
  await page.goto("/models");
  await page.getByLabel("Type").selectOption("ollama");
  await page.getByLabel("Name", { exact: true }).fill("Local Ollama");
  await page.getByLabel("Base URL (optional for hosted providers)").fill("http://127.0.0.1:11434/v1");
  await page.getByRole("button", { name: "Add provider" }).click();
  await expect(page.getByText("Added Local Ollama.")).toBeVisible();

  await page.getByLabel("Model ID").fill("qwen3:14b");
  await page.getByLabel("Display name").fill("Qwen3 14B");
  await page.getByRole("button", { name: "Add model" }).click();
  await expect(page.getByRole("cell", { name: /Qwen3 14B/ })).toBeVisible();
});

test("agents: hire, budget, pause and resume", async () => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "Hire Nina" }).click();
  await expect(page.getByRole("heading", { name: "Nina" })).toBeVisible();
  await expect(page.getByText("Network Discovery")).toBeVisible();

  await page.getByLabel("Per").selectOption("day");
  await page.getByLabel("Hard limit").fill("2");
  await page.getByRole("button", { name: "Set budget" }).click();
  await expect(page.getByText("Budget saved.")).toBeVisible();
  await expect(page.getByText(/\$0\.0000 \/ \$2\.00/)).toBeVisible();

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(page.getByText("paused", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
});

test("incidents: raise, comment and update", async () => {
  await page.goto("/incidents");
  await page.getByLabel("Title").fill("Printer offline");
  await page.getByLabel("Description").fill("Nobody can print since this morning.");
  await page.getByLabel("Priority").selectOption("P2");
  await page.getByRole("button", { name: "Raise incident" }).click();
  await expect(page.getByRole("heading", { name: /INC-\d+: Printer offline/ })).toBeVisible();

  await page.getByLabel("Comment").fill("Checked the cable.");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByText("Checked the cable.")).toBeVisible();

  await page.getByLabel("Status").selectOption("in_progress");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Incident updated.")).toBeVisible();
});

test("changes: approve what an agent submitted", async () => {
  // An agent raises a change (what the worker would do); the owner approves it in the UI.
  const db = createDb(E2E_DATABASE_URL);
  const [nina] = await db.select().from(agents).where(eq(agents.name, "Nina"));
  await createChangeRequest(
    db,
    nina!.orgId,
    {
      type: "normal",
      title: "Wake the NAS",
      description: "The NAS is asleep and backups are due.",
      rollbackPlan: "None needed.",
      verificationPlan: "ping 192.168.50.10",
      plannedCalls: [{ tool: "wake_on_lan", args: { mac: "aa:bb:cc:dd:ee:ff", broadcast: "192.168.50.255" } }],
    },
    { type: "agent", id: nina!.id },
  );

  await page.goto("/changes");
  await page.getByRole("link", { name: "Wake the NAS" }).click();
  await expect(page.getByText("wake_on_lan")).toBeVisible();
  await expect(page.getByText(/"broadcast": "192\.168\.50\.255"/)).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Approved\. The agent will be told/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
});

test("settings: the kill switch stops agents and shows everywhere", async () => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Turn on" }).first().click();
  await expect(page.getByRole("status")).toContainText("All agents are paused");
  await page.goto("/agents");
  await expect(page.getByRole("status")).toContainText("All agents are paused");
  await page.goto("/settings");
  await page.getByRole("button", { name: "Turn off" }).first().click();
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("two-factor: enrol, then sign in with a code", async () => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Set up two-factor" }).click();
  await page.getByText("Can't scan? Enter this key instead").click();
  const secret = (await page.locator("details code").textContent())!.trim();
  ownerTotpSecret = secret;
  await page.getByLabel("Code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Two-factor authentication is on for")).toBeVisible();

  await signOut();
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Authenticator code").fill("000000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Incorrect email, password or code.")).toBeVisible();
  await page.getByLabel("Authenticator code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});

test("users: a viewer can look but not approve or manage", async () => {
  await page.goto("/users");
  await page.getByLabel("Name").fill(VIEWER.name);
  await page.getByLabel("Email").fill(VIEWER.email);
  await page.getByLabel("Initial password").fill(VIEWER.password);
  await page.getByRole("button", { name: "Add person" }).click();
  await expect(page.getByRole("cell", { name: /Vic Viewer/ })).toBeVisible();

  await signOut();
  await signIn(VIEWER.email, VIEWER.password);
  await page.goto("/users");
  await expect(page.getByText("You don't have permission to view this page.")).toBeVisible();
  await page.goto("/changes?view=all");
  await page.getByRole("link", { name: "Wake the NAS" }).click();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await page.goto("/agents");
  await expect(page.getByRole("button", { name: /^Hire/ })).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Turn on" })).toHaveCount(0);
});

test("audit: the log is intact after all of that", async () => {
  await signOut();
  await signIn(OWNER.email, OWNER.password, totpCode(ownerTotpSecret));
  await page.goto("/audit");
  await expect(page.getByText("tool.denied")).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "change.approve" })).toBeVisible();
  await page.getByRole("button", { name: "Verify integrity" }).click();
  await expect(page.getByText("The audit log is intact")).toBeVisible();
});
