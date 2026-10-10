// Google Workspace, read-only through a service account with domain-wide delegation, acting as an admin: people,
// managed mobile and ChromeOS devices, and Alert Center alerts. The service account signs its own token request
// (RS256), so no Google SDK is needed. Each call asks only for the read-only scope it uses.
import { createPrivateKey, sign } from "node:crypto";
import { clean } from "./parsers.js";

export class GoogleError extends Error {}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []) as Record<string, unknown>[];

interface Creds {
  /** The service account's JSON key. */
  serviceAccount: string;
  adminEmail: string;
  timeoutMs: number;
}

const SCOPE = {
  users: "https://www.googleapis.com/auth/admin.directory.user.readonly",
  mobile: "https://www.googleapis.com/auth/admin.directory.device.mobile.readonly",
  chromeos: "https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly",
  alerts: "https://www.googleapis.com/auth/apps.alerts",
};

export function serviceAccountAssertion(sa: { client_email: string; private_key: string }, adminEmail: string, scopes: string[], now = new Date()) {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(now.getTime() / 1000);
  const body = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: sa.client_email, sub: adminEmail, scope: scopes.join(" "), aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), createPrivateKey(sa.private_key)).toString("base64url")}`;
}

async function token(a: Creds, scopes: string[], f: Fetch): Promise<string> {
  let sa: { client_email?: string; private_key?: string };
  try {
    sa = JSON.parse(a.serviceAccount);
  } catch {
    throw new GoogleError("The stored service account key isn't the JSON file Google gave you");
  }
  if (!sa.client_email || !sa.private_key) throw new GoogleError("The service account key has no client_email or private_key");
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(sa as { client_email: string; private_key: string }, a.adminEmail, scopes) }).toString(),
    signal: AbortSignal.timeout(a.timeoutMs),
  });
  const body = obj(await res.json().catch(() => ({})));
  if (res.status !== 200 || typeof body.access_token !== "string") {
    const why = clean(body.error_description) ?? clean(body.error) ?? `HTTP ${res.status}`;
    throw new GoogleError(
      body.error === "unauthorized_client" ? `The service account isn't allowed these scopes (domain-wide delegation in the Admin console): ${scopes.join(", ")}` : `Google refused the service account: ${why}`,
    );
  }
  return body.access_token;
}

async function list(f: Fetch, tok: string, url: string, field: string, timeoutMs: number, max = 2000): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(url);
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await f(u.toString(), { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(timeoutMs) });
    const body = obj(await res.json().catch(() => ({})));
    if (res.status === 403) throw new GoogleError(`The admin the service account acts as can't read ${u.pathname} (${clean(obj(body.error).message) ?? "forbidden"})`);
    if (res.status !== 200) throw new GoogleError(`Google answered HTTP ${res.status} for ${u.pathname}`);
    out.push(...arr(body[field]));
    pageToken = clean(body.nextPageToken);
  } while (pageToken && out.length < max);
  return out.slice(0, max);
}

const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1";

export async function gworkspaceUsers(a: Creds, f: Fetch = fetch as unknown as Fetch) {
  const tok = await token(a, [SCOPE.users], f);
  const rows = await list(f, tok, `${DIRECTORY}/users?customer=my_customer&maxResults=500&projection=basic`, "users", a.timeoutMs);
  return {
    users: rows.map((u) => ({
      id: clean(u.id),
      email: clean(u.primaryEmail),
      name: clean(obj(u.name).fullName),
      suspended: u.suspended === true,
      admin: u.isAdmin === true,
      twoStep: u.isEnrolledIn2Sv === true,
      lastLogin: clean(u.lastLoginTime),
    })),
  };
}

const mac = (m: unknown) => {
  const s = clean(m)?.replace(/[:-]/g, "").toLowerCase();
  return s && /^[0-9a-f]{12}$/.test(s) ? s.match(/../g)!.join(":") : null;
};

export async function gworkspaceDevices(a: Creds, f: Fetch = fetch as unknown as Fetch) {
  const tok = await token(a, [SCOPE.mobile, SCOPE.chromeos], f);
  const mobile = await list(f, tok, `${DIRECTORY}/customer/my_customer/devices/mobile?maxResults=100&projection=FULL`, "mobiledevices", a.timeoutMs);
  const chrome = await list(f, tok, `${DIRECTORY}/customer/my_customer/devices/chromeos?maxResults=100&projection=FULL`, "chromeosdevices", a.timeoutMs);
  return {
    devices: [
      ...mobile.map((d) => ({
        id: clean(d.resourceId),
        kind: "mobile" as const,
        name: clean(d.model) ?? clean(d.deviceId),
        os: clean(d.os),
        serial: clean(d.serialNumber),
        user: Array.isArray(d.email) ? clean(d.email[0]) : undefined,
        status: clean(d.status),
        lastSync: clean(d.lastSync),
        macs: [mac(d.wifiMacAddress)].filter((m): m is string => !!m),
        ips: [] as string[],
      })),
      ...chrome.map((d) => ({
        id: clean(d.deviceId),
        kind: "chromeos" as const,
        name: clean(d.annotatedAssetId) ?? clean(d.model) ?? clean(d.serialNumber),
        os: clean(d.osVersion) ? `ChromeOS ${clean(d.osVersion)}` : "ChromeOS",
        serial: clean(d.serialNumber),
        user: clean(d.annotatedUser),
        status: clean(d.status),
        lastSync: clean(d.lastSync),
        macs: [mac(d.macAddress), mac(d.ethernetMacAddress)].filter((m): m is string => !!m),
        ips: arr(d.lastKnownNetwork).map((n) => clean(n.ipAddress)).filter((ip): ip is string => !!ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)),
      })),
    ],
  };
}

/** Alert Center alerts from the last 7 days that haven't been closed. */
export async function gworkspaceAlerts(a: Creds, f: Fetch = fetch as unknown as Fetch, now = new Date()) {
  const tok = await token(a, [SCOPE.alerts], f);
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const rows = await list(f, tok, `https://alertcenter.googleapis.com/v1beta1/alerts?pageSize=100&filter=${encodeURIComponent(`createTime >= "${since}"`)}`, "alerts", a.timeoutMs, 200);
  return {
    alerts: rows
      .map((r) => ({
        id: clean(r.alertId),
        type: clean(r.type),
        source: clean(r.source),
        created: clean(r.createTime),
        status: clean(obj(r.metadata).status) ?? "NOT_STARTED",
        severity: clean(obj(r.metadata).severity) ?? "MEDIUM",
      }))
      .filter((r) => r.status !== "CLOSED"),
  };
}
