// Microsoft 365 and Google Workspace: what they put in the inventory and on monitors.
import { describe, expect, it } from "vitest";
import { parseIntegrationConfig } from "./integrations/config.js";
import { gworkspaceAlertsHealth, gworkspaceInventory } from "./integrations/google-workspace.js";
import { M365, m365Health, m365Inventory } from "./integrations/m365.js";

const now = new Date("2030-01-01T00:00:00Z");

describe("Microsoft 365", () => {
  it("puts Intune devices in the inventory, even away from the office network", () => {
    const out = m365Inventory({
      devices: [
        { id: "d1", name: "LAPTOP-1", os: "Windows 11", serial: "SN1", user: "ann@acme.test", compliance: "compliant", macs: ["a1:b2:c3:d4:e5:f6"] },
        { id: "d2", name: "PHONE-1", os: "iOS 18", compliance: "noncompliant", macs: [] },
      ],
    });
    expect(out.inventory!.map((i) => [i.name, i.kind, i.createWithoutIp])).toEqual([
      ["LAPTOP-1", "workstation", true],
      ["PHONE-1", "phone", true],
    ]);
    expect(out.summary).toBe("2 managed device(s), 1 not compliant");
  });

  it("raises one monitor per concern, and skips what the app can't read", () => {
    const c = parseIntegrationConfig(M365, {});
    const out = m365Health(
      {
        issues: [
          { service: "Exchange Online", title: "Mail delayed", classification: "incident" },
          { service: "Teams", title: "Slow joins", classification: "advisory" },
        ],
        nonCompliant: [],
        riskyUsers: null,
        secretExpires: "2030-01-20T00:00:00Z",
      },
      c,
      now,
    );
    expect(out.alerts!.map((a) => [a.key, a.status, a.message])).toEqual([
      ["service", "down", "Exchange Online: Mail delayed, Teams: Slow joins (advisory)"],
      ["compliance", "up", "Every managed device is compliant"],
      ["app-secret", "degraded", "The client secret expires in 19 days"],
    ]);
    expect(m365Health({ issues: null, nonCompliant: null, riskyUsers: null, secretExpires: null }, c, now).summary).toBe("Nothing the app may read (check its permissions)");
  });
});

describe("Google Workspace", () => {
  it("puts phones and Chromebooks in the inventory", () => {
    expect(gworkspaceInventory({ devices: [{ id: "c1", kind: "chromeos", name: "CB-1", macs: [], ips: ["192.168.1.50"] }, { kind: "mobile", macs: [], ips: [] }] }).inventory).toEqual([
      expect.objectContaining({ externalId: "c1", name: "CB-1", kind: "workstation", ips: ["192.168.1.50"] }),
    ]);
  });

  it("is down for high-severity alerts, degraded for others", () => {
    const high = gworkspaceAlertsHealth({ alerts: [{ type: "Suspicious login", status: "NOT_STARTED", severity: "HIGH" }, { type: "Phishing", status: "IN_PROGRESS", severity: "LOW" }] });
    expect(high.alerts![0]).toMatchObject({ status: "down", message: "Open alerts: Suspicious login (high), Phishing. See the Admin console's Alert Center.", value: 2 });
    expect(gworkspaceAlertsHealth({ alerts: [] }).alerts![0]!.status).toBe("up");
  });
});
