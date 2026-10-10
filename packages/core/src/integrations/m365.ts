// Microsoft 365 / Entra ID (business): read-only. One app registration does both single sign-on and reading, with
// Microsoft Graph application permissions an admin consents to. Inventory: Intune-managed laptops and phones.
// Health: Microsoft 365 service incidents, devices out of compliance, risky users (Entra ID P2) and the app secret
// running out, each as one monitor (they recover when the problem goes).
import type { ParsedAlert } from "../monitoring/webhooks.js";
import { integrationOption, type FeatureOutput, type IntegrationConfig, type IntegrationDef } from "./types.js";

const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

interface Device {
  id: string;
  name?: string;
  os?: string;
  serial?: string;
  vendor?: string;
  model?: string;
  user?: string;
  compliance: string;
  lastSync?: string;
  macs: string[];
}
interface Health {
  issues: { id?: string; service?: string; title?: string; classification: string; status?: string }[] | null;
  nonCompliant: string[] | null;
  riskyUsers: { name?: string; upn?: string; level: string }[] | null;
  secretExpires: string | null;
}

const kindOf = (os?: string) => (/ios|android|ipad/i.test(os ?? "") ? "phone" : "workstation");

export function m365Inventory(r: { devices: Device[] }): FeatureOutput {
  return {
    inventory: r.devices
      .filter((d) => d.id)
      .map((d) => ({
        externalId: d.id,
        name: d.name,
        kind: kindOf(d.os),
        ...(d.vendor ? { vendor: d.vendor } : {}),
        ...(d.model ? { model: d.model } : {}),
        ...(d.os ? { os: d.os } : {}),
        ips: [],
        macs: d.macs,
        // Laptops and phones are often away from the office network: they're still yours.
        createWithoutIp: true,
        details: { user: d.user, serial: d.serial, compliance: d.compliance, lastCheckIn: d.lastSync },
      })),
    summary: `${r.devices.length} managed device(s), ${r.devices.filter((d) => d.compliance === "noncompliant").length} not compliant`,
  };
}

const list = (xs: string[], n = 6) => `${xs.slice(0, n).join(", ")}${xs.length > n ? ` and ${xs.length - n} more` : ""}`;

export function m365Health(r: Health, c: IntegrationConfig, now: Date): FeatureOutput {
  const alerts: ParsedAlert[] = [];
  if (r.issues) {
    const incidents = r.issues.filter((i) => i.classification === "incident");
    alerts.push({
      key: "service",
      name: "Microsoft 365 service health",
      status: incidents.length ? "down" : r.issues.length ? "degraded" : "up",
      message: r.issues.length ? list(r.issues.map((i) => `${i.service}: ${i.title}${i.classification === "incident" ? "" : " (advisory)"}`), 4) : "All services healthy",
      value: r.issues.length,
    });
  }
  if (r.nonCompliant) {
    alerts.push({
      key: "compliance",
      name: "Intune device compliance",
      status: r.nonCompliant.length ? "degraded" : "up",
      message: r.nonCompliant.length ? `Not compliant: ${list(r.nonCompliant)}` : "Every managed device is compliant",
      value: r.nonCompliant.length,
    });
  }
  if (r.riskyUsers) {
    const high = r.riskyUsers.filter((u) => u.level === "high");
    alerts.push({
      key: "risky-users",
      name: "Entra ID risky users",
      status: high.length ? "down" : r.riskyUsers.length ? "degraded" : "up",
      message: r.riskyUsers.length ? `At risk: ${list(r.riskyUsers.map((u) => `${u.upn ?? u.name} (${u.level})`))}` : "Nobody is flagged as at risk",
      value: r.riskyUsers.length,
    });
  }
  if (r.secretExpires) {
    const days = Math.floor((Date.parse(r.secretExpires) - now.getTime()) / 86_400_000);
    const warn = integrationOption(M365, c, "secretWarnDays");
    alerts.push({
      key: "app-secret",
      name: "MOSS's Microsoft app secret",
      status: days < 0 ? "down" : days <= warn ? "degraded" : "up",
      message: days < 0 ? "The client secret has expired: make a new one and store it on the integration's page" : `The client secret expires in ${days} days`,
      value: days,
    });
  }
  const parts = [
    r.issues && `${r.issues.length} open service issue(s)`,
    r.nonCompliant && `${r.nonCompliant.length} non-compliant device(s)`,
    r.riskyUsers && `${r.riskyUsers.length} risky user(s)`,
  ].filter(Boolean);
  return { alerts, summary: parts.length ? parts.join(", ") : "Nothing the app may read (check its permissions)" };
}

export const M365: IntegrationDef = {
  key: "m365",
  name: "Microsoft 365",
  description: "Sign in with Microsoft, Intune laptops and phones in the inventory, and Microsoft 365 service health, device compliance and risky users watched. Read-only.",
  plan: "business",
  connection: {
    defaultPort: 443,
    cloud: true,
    fields: [
      { key: "tenantId", label: "Directory (tenant) ID", pattern: UUID, message: "The directory (tenant) ID, from the app registration's Overview" },
      { key: "clientId", label: "Application (client) ID", pattern: UUID, message: "The application (client) ID, from the app registration's Overview" },
    ],
    hint: "An app registration in the Entra admin centre (App registrations > New registration, single tenant). MOSS reads Microsoft Graph with it, and signs people in with it if you switch that on.",
  },
  credential: {
    secretName: "m365-client-secret",
    type: "api_token",
    arg: "clientSecret",
    label: "Client secret",
    hint: "The app registration's Certificates & secrets > New client secret: the Value, not the ID. MOSS warns before it expires.",
    tools: ["m365_users", "m365_devices", "m365_service_health", "oidc_exchange"],
  },
  test: {
    op: "users",
    describe: (r) => `Connected to Microsoft 365: ${(r as { users: unknown[] }).users.length} people.`,
  },
  ops: { users: { tool: "m365_users" }, devices: { tool: "m365_devices" }, health: { tool: "m365_service_health" } },
  features: [
    {
      key: "inventory",
      label: "Intune devices in the inventory",
      description: "Every 6 hours: laptops and phones managed in Intune, with their user, serial and compliance (needs DeviceManagementManagedDevices.Read.All).",
      everyMs: 6 * 60 * 60_000,
      op: "devices",
      apply: (r) => m365Inventory(r as { devices: Device[] }),
    },
    {
      key: "health",
      label: "Service health and security",
      description:
        "Every 15 minutes: Microsoft 365 service incidents (ServiceHealth.Read.All), devices out of compliance, people Entra ID flags as at risk (IdentityRiskyUser.Read.All, Entra ID P2) and the app secret running out (Application.Read.All). Each is skipped if the permission isn't granted.",
      everyMs: 15 * 60_000,
      op: "health",
      apply: (r, { config, now }) => m365Health(r as Health, config, now),
    },
  ],
  options: [{ key: "secretWarnDays", label: "Warn when the app secret expires within (days)", default: 30, min: 1, max: 180 }],
  agentTools: ["m365_users", "m365_devices", "m365_service_health"],
};
