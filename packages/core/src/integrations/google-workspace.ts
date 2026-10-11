// Google Workspace (business): read-only, through a service account with domain-wide delegation acting as an admin.
// Inventory: managed phones, tablets and Chromebooks. Health: open Alert Center alerts (suspicious sign-ins,
// phishing, leaked passwords) as one monitor. Signing in with Google uses its own OAuth client (set up separately).
import type { FeatureOutput, IntegrationDef } from "./types.js";

interface Device {
  id?: string;
  kind: "mobile" | "chromeos";
  name?: string;
  os?: string;
  serial?: string;
  user?: string;
  status?: string;
  lastSync?: string;
  macs: string[];
  ips: string[];
}
interface Alert {
  id?: string;
  type?: string;
  source?: string;
  created?: string;
  status: string;
  severity: string;
}

export function gworkspaceInventory(r: { devices: Device[] }): FeatureOutput {
  return {
    inventory: r.devices
      .filter((d): d is Device & { id: string } => !!d.id)
      .map((d) => ({
        externalId: d.id,
        name: d.name,
        kind: d.kind === "chromeos" ? "workstation" : "phone",
        ...(d.os ? { os: d.os } : {}),
        ips: d.ips,
        macs: d.macs,
        createWithoutIp: true,
        details: { user: d.user, serial: d.serial, status: d.status, lastSync: d.lastSync },
      })),
    summary: `${r.devices.length} managed device(s)`,
  };
}

export function gworkspaceAlertsHealth(r: { alerts: Alert[] }): FeatureOutput {
  const high = r.alerts.filter((a) => a.severity === "HIGH");
  const shown = r.alerts.slice(0, 5).map((a) => `${a.type}${a.severity === "HIGH" ? " (high)" : ""}`);
  return {
    alerts: [
      {
        key: "alerts",
        name: "Google Workspace security alerts",
        status: high.length ? "down" : r.alerts.length ? "degraded" : "up",
        message: r.alerts.length ? `Open alerts: ${shown.join(", ")}${r.alerts.length > 5 ? ` and ${r.alerts.length - 5} more` : ""}. See the Admin console's Alert Center.` : "No open alerts",
        value: r.alerts.length,
      },
    ],
    summary: `${r.alerts.length} open alert(s)`,
  };
}

export const GOOGLE_WORKSPACE: IntegrationDef = {
  key: "google_workspace",
  name: "Google Workspace",
  description: "Sign in with Google, managed phones and Chromebooks in the inventory, and Alert Center security alerts watched. Read-only.",
  plan: "business",
  connection: {
    defaultPort: 443,
    cloud: true,
    fields: [
      {
        key: "adminEmail",
        label: "Admin to act as",
        hint: "A Workspace admin who can read users, devices and alerts. The service account acts as them.",
        pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
        message: "An admin's email address",
      },
    ],
    hint: "A service account in Google Cloud (IAM & Admin > Service accounts > Keys > Add key > JSON), with domain-wide delegation in the Admin console (Security > API controls) for the read-only scopes listed below.",
  },
  credential: {
    secretName: "google-service-account",
    type: "api_token",
    arg: "serviceAccount",
    label: "Service account key (JSON)",
    hint: "Paste the whole JSON key file. Delegate only these scopes: admin.directory.user.readonly, admin.directory.device.mobile.readonly, admin.directory.device.chromeos.readonly and apps.alerts (each https://www.googleapis.com/auth/...).",
    tools: ["gworkspace_users", "gworkspace_devices", "gworkspace_alerts"],
  },
  test: {
    op: "users",
    describe: (r) => `Connected to Google Workspace: ${(r as { users: unknown[] }).users.length} people.`,
  },
  ops: { users: { tool: "gworkspace_users" }, devices: { tool: "gworkspace_devices" }, alerts: { tool: "gworkspace_alerts" } },
  features: [
    {
      key: "inventory",
      label: "Managed devices in the inventory",
      description: "Every 6 hours: phones, tablets and Chromebooks Google Workspace manages, with their user and serial.",
      everyMs: 6 * 60 * 60_000,
      op: "devices",
      apply: (r) => gworkspaceInventory(r as { devices: Device[] }),
    },
    {
      key: "alerts",
      label: "Security alerts",
      description: "Every 15 minutes: Alert Center alerts from the last 7 days that aren't closed. High-severity ones raise an incident.",
      everyMs: 15 * 60_000,
      op: "alerts",
      apply: (r) => gworkspaceAlertsHealth(r as { alerts: Alert[] }),
    },
  ],
  agentTools: ["gworkspace_users", "gworkspace_devices", "gworkspace_alerts"],
};
