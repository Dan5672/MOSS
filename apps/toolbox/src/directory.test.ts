// Microsoft 365, Google Workspace and the sign-in exchange, against stand-in APIs.
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gworkspaceAlerts, gworkspaceDevices, serviceAccountAssertion } from "./google.js";
import { m365Devices, m365ServiceHealth } from "./microsoft.js";
import { oidcExchange } from "./oidc.js";

type Reply = { status?: number; body: unknown };
function api(routes: Record<string, Reply | ((body?: string) => Reply)>) {
  const calls: { url: string; method: string; body?: string; auth?: string }[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body, auth: init?.headers?.Authorization });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const r = key ? routes[key]! : { status: 404, body: {} };
    const reply = typeof r === "function" ? r(init?.body) : r;
    return { status: reply.status ?? 200, json: async () => reply.body };
  };
  return { fetchImpl, calls };
}

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ms = { tenantId: TENANT, clientId: CLIENT, clientSecret: "s3cret", timeoutMs: 5000 };
const msToken = { [`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`]: { body: { access_token: "tok" } } };

describe("Microsoft 365", () => {
  it("lists Intune devices with tidy MAC addresses, following pages", async () => {
    const { fetchImpl, calls } = api({
      ...msToken,
      "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$skiptoken=2": { body: { value: [{ id: "d2", deviceName: "PHONE-1", operatingSystem: "iOS", complianceState: "noncompliant" }] } },
      "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices": {
        body: {
          value: [{ id: "d1", deviceName: "LAPTOP-1", operatingSystem: "Windows", osVersion: "10.0.22631", serialNumber: "SN1", userPrincipalName: "ann@acme.test", complianceState: "compliant", wiFiMacAddress: "A1B2C3D4E5F6" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$skiptoken=2",
        },
      },
    });
    const res = await m365Devices(ms, fetchImpl);
    expect(res.devices).toEqual([
      expect.objectContaining({ id: "d1", name: "LAPTOP-1", os: "Windows 10.0.22631", serial: "SN1", user: "ann@acme.test", compliance: "compliant", macs: ["a1:b2:c3:d4:e5:f6"] }),
      expect.objectContaining({ id: "d2", name: "PHONE-1", compliance: "noncompliant", macs: [] }),
    ]);
    expect(new URLSearchParams(calls[0]!.body)).toEqual(new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT, client_secret: "s3cret", scope: "https://graph.microsoft.com/.default" }));
    expect(calls[1]!.auth).toBe("Bearer tok");
  });

  it("reports health, leaving out what the app isn't allowed to read", async () => {
    const { fetchImpl } = api({
      ...msToken,
      "https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/issues": { body: { value: [{ id: "EX1", service: "Exchange Online", title: "Mail delayed", classification: "incident", status: "serviceDegradation" }] } },
      "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices": { body: { value: [{ deviceName: "PHONE-1", complianceState: "noncompliant" }, { deviceName: "LAPTOP-1", complianceState: "compliant" }] } },
      "https://graph.microsoft.com/v1.0/identityProtection/riskyUsers": { status: 403, body: { error: { message: "Forbidden" } } },
      "https://graph.microsoft.com/v1.0/applications": { body: { value: [{ passwordCredentials: [{ endDateTime: "2030-03-01T00:00:00Z" }, { endDateTime: "2031-03-01T00:00:00Z" }] }] } },
    });
    expect(await m365ServiceHealth(ms, fetchImpl)).toEqual({
      issues: [{ id: "EX1", service: "Exchange Online", title: "Mail delayed", classification: "incident", status: "serviceDegradation", started: undefined }],
      nonCompliant: ["PHONE-1"],
      riskyUsers: null,
      secretExpires: "2031-03-01T00:00:00Z",
    });
  });

  it("says plainly when Microsoft refuses the app", async () => {
    const { fetchImpl } = api({ [`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`]: { status: 401, body: { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x" } } });
    await expect(m365Devices(ms, fetchImpl)).rejects.toThrow("Microsoft refused the app's sign-in: AADSTS7000215: Invalid client secret provided.");
  });
});

describe("Google Workspace", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = JSON.stringify({ type: "service_account", client_email: "moss@acme.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  const gws = { serviceAccount: sa, adminEmail: "admin@acme.test", timeoutMs: 5000 };

  it("signs the service account's token request for the admin, with only the scopes needed", () => {
    const jwt = serviceAccountAssertion(JSON.parse(sa), "admin@acme.test", ["s1", "s2"], new Date("2030-01-01T00:00:00Z"));
    const [h, b, s] = jwt.split(".");
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(b!, "base64url").toString())).toEqual({ iss: "moss@acme.iam.gserviceaccount.com", sub: "admin@acme.test", scope: "s1 s2", aud: "https://oauth2.googleapis.com/token", iat: 1893456000, exp: 1893459600 });
  });

  it("lists phones and Chromebooks", async () => {
    const { fetchImpl, calls } = api({
      "https://oauth2.googleapis.com/token": { body: { access_token: "gtok" } },
      "https://admin.googleapis.com/admin/directory/v1/customer/my_customer/devices/mobile": { body: { mobiledevices: [{ resourceId: "m1", model: "Pixel 8", os: "Android 15", email: ["bob@acme.test"], status: "APPROVED", wifiMacAddress: "aa:bb:cc:dd:ee:ff" }] } },
      "https://admin.googleapis.com/admin/directory/v1/customer/my_customer/devices/chromeos": { body: { chromeosdevices: [{ deviceId: "c1", serialNumber: "CB1", model: "Chromebook", osVersion: "130", annotatedUser: "eve@acme.test", macAddress: "001122334455", lastKnownNetwork: [{ ipAddress: "192.168.1.50" }] }] } },
    });
    const res = await gworkspaceDevices(gws, fetchImpl);
    expect(res.devices).toEqual([
      expect.objectContaining({ id: "m1", kind: "mobile", name: "Pixel 8", os: "Android 15", user: "bob@acme.test", macs: ["aa:bb:cc:dd:ee:ff"] }),
      expect.objectContaining({ id: "c1", kind: "chromeos", name: "Chromebook", os: "ChromeOS 130", user: "eve@acme.test", macs: ["00:11:22:33:44:55"], ips: ["192.168.1.50"] }),
    ]);
    const scopes = JSON.parse(Buffer.from(new URLSearchParams(calls[0]!.body).get("assertion")!.split(".")[1]!, "base64url").toString()).scope;
    expect(scopes).toBe("https://www.googleapis.com/auth/admin.directory.device.mobile.readonly https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly");
  });

  it("lists open alerts, and explains missing delegation", async () => {
    const { fetchImpl } = api({
      "https://oauth2.googleapis.com/token": { body: { access_token: "gtok" } },
      "https://alertcenter.googleapis.com/v1beta1/alerts": {
        body: {
          alerts: [
            { alertId: "a1", type: "Suspicious login", source: "Google identity", createTime: "2030-01-01T00:00:00Z", metadata: { status: "NOT_STARTED", severity: "HIGH" } },
            { alertId: "a2", type: "Phishing", metadata: { status: "CLOSED" } },
          ],
        },
      },
    });
    expect((await gworkspaceAlerts(gws, fetchImpl)).alerts).toEqual([{ id: "a1", type: "Suspicious login", source: "Google identity", created: "2030-01-01T00:00:00Z", status: "NOT_STARTED", severity: "HIGH" }]);
    const denied = api({ "https://oauth2.googleapis.com/token": { status: 401, body: { error: "unauthorized_client" } } });
    await expect(gworkspaceAlerts(gws, denied.fetchImpl)).rejects.toThrow(/isn't allowed these scopes \(domain-wide delegation/);
  });
});

describe("sign-in exchange", () => {
  it("swaps the code for the ID token only, with PKCE", async () => {
    const { fetchImpl, calls } = api({ "https://oauth2.googleapis.com/token": { body: { id_token: "a.b.c", access_token: "not-kept", refresh_token: "not-kept" } } });
    const verifier = "v".repeat(43);
    expect(await oidcExchange({ provider: "google", clientId: "g", clientSecret: "gs", code: "c0de", redirectUri: "https://moss.acme.test/api/auth/sso/google/callback", codeVerifier: verifier, timeoutMs: 5000 }, fetchImpl)).toEqual({ idToken: "a.b.c" });
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toMatchObject({ grant_type: "authorization_code", code: "c0de", code_verifier: verifier, client_secret: "gs" });
  });
});
