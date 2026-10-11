// Microsoft 365 / Entra ID, read-only through Microsoft Graph with the app registration's own (application)
// permissions: people, Intune-managed devices, service health, risky users and when the app's secret runs out.
import { arr, obj } from "./homelab.js";
import { clean } from "./parsers.js";

export class MicrosoftError extends Error {}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

interface Creds {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
}

const GRAPH = "https://graph.microsoft.com/v1.0";

async function token(a: Creds, f: Fetch): Promise<string> {
  const res = await f(`https://login.microsoftonline.com/${encodeURIComponent(a.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: a.clientId, client_secret: a.clientSecret, scope: "https://graph.microsoft.com/.default" }).toString(),
    signal: AbortSignal.timeout(a.timeoutMs),
  });
  const body = obj(await res.json().catch(() => ({})));
  if (res.status !== 200 || typeof body.access_token !== "string") {
    const why = clean(body.error_description)?.split("\r\n")[0] ?? clean(body.error) ?? `HTTP ${res.status}`;
    throw new MicrosoftError(`Microsoft refused the app's sign-in: ${why}`);
  }
  return body.access_token;
}

/** One Graph list, following pages up to a limit. A missing permission is reported, not thrown, when `optional`. */
async function list(f: Fetch, tok: string, path: string, timeoutMs: number, opts: { max?: number; optional?: boolean } = {}): Promise<Record<string, unknown>[] | null> {
  const out: Record<string, unknown>[] = [];
  let url: string | undefined = `${GRAPH}${path}`;
  while (url && out.length < (opts.max ?? 2000)) {
    const res = await f(url, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(timeoutMs) });
    const body = obj(await res.json().catch(() => ({})));
    if (res.status === 403 || res.status === 401) {
      if (opts.optional) return null;
      throw new MicrosoftError(`The app isn't allowed to read ${path.split("?")[0]} (grant the permission and admin consent)`);
    }
    if (res.status !== 200) throw new MicrosoftError(`Graph answered HTTP ${res.status} for ${path.split("?")[0]}: ${clean(obj(body.error).message) ?? ""}`.trim());
    out.push(...arr(body.value));
    url = typeof body["@odata.nextLink"] === "string" && body["@odata.nextLink"].startsWith(GRAPH) ? body["@odata.nextLink"] : undefined;
  }
  return out.slice(0, opts.max ?? 2000);
}

export async function m365Users(a: Creds, f: Fetch = fetch as unknown as Fetch) {
  const tok = await token(a, f);
  const rows = (await list(f, tok, "/users?$select=id,displayName,userPrincipalName,mail,accountEnabled,jobTitle,department&$top=999", a.timeoutMs))!;
  return {
    users: rows.map((u) => ({
      id: clean(u.id),
      name: clean(u.displayName),
      upn: clean(u.userPrincipalName),
      email: clean(u.mail),
      enabled: u.accountEnabled !== false,
      jobTitle: clean(u.jobTitle),
      department: clean(u.department),
    })),
  };
}

export async function m365Devices(a: Creds, f: Fetch = fetch as unknown as Fetch) {
  const tok = await token(a, f);
  const rows = (await list(
    f,
    tok,
    "/deviceManagement/managedDevices?$select=id,deviceName,operatingSystem,osVersion,serialNumber,manufacturer,model,userPrincipalName,complianceState,lastSyncDateTime,wiFiMacAddress,ethernetMacAddress",
    a.timeoutMs,
  ))!;
  return {
    devices: rows.map((d) => ({
      id: clean(d.id),
      name: clean(d.deviceName),
      os: [clean(d.operatingSystem), clean(d.osVersion)].filter(Boolean).join(" ") || undefined,
      serial: clean(d.serialNumber),
      vendor: clean(d.manufacturer),
      model: clean(d.model),
      user: clean(d.userPrincipalName),
      compliance: clean(d.complianceState) ?? "unknown",
      lastSync: clean(d.lastSyncDateTime),
      macs: [clean(d.wiFiMacAddress), clean(d.ethernetMacAddress)].filter((m): m is string => !!m && /^[0-9a-f]{12}$/i.test(m.replace(/[:-]/g, ""))).map((m) => m.replace(/[:-]/g, "").toLowerCase().match(/../g)!.join(":")),
    })),
  };
}

/** Service incidents, non-compliant devices, risky users (Entra ID P2) and the app's secret expiry, each optional. */
export async function m365ServiceHealth(a: Creds, f: Fetch = fetch as unknown as Fetch) {
  const tok = await token(a, f);
  const issues = await list(f, tok, "/admin/serviceAnnouncement/issues?$filter=isResolved eq false&$top=100", a.timeoutMs, { max: 100, optional: true });
  const devices = await list(f, tok, "/deviceManagement/managedDevices?$select=id,deviceName,complianceState", a.timeoutMs, { optional: true });
  const risky = await list(f, tok, "/identityProtection/riskyUsers?$filter=riskState eq 'atRisk'&$top=100", a.timeoutMs, { max: 100, optional: true });
  const apps = await list(f, tok, `/applications?$filter=appId eq '${a.clientId.replace(/'/g, "")}'&$select=passwordCredentials`, a.timeoutMs, { max: 1, optional: true });
  const secrets = arr(obj(apps?.[0]).passwordCredentials).map((p) => clean(p.endDateTime)).filter((d): d is string => !!d);
  return {
    issues:
      issues?.map((i) => ({
        id: clean(i.id),
        service: clean(i.service),
        title: clean(i.title),
        classification: clean(i.classification) ?? "advisory",
        status: clean(i.status),
        started: clean(i.startDateTime),
      })) ?? null,
    nonCompliant: devices ? devices.filter((d) => clean(d.complianceState) === "noncompliant").map((d) => clean(d.deviceName) ?? "?") : null,
    riskyUsers: risky?.map((u) => ({ name: clean(u.userDisplayName), upn: clean(u.userPrincipalName), level: clean(u.riskLevel) ?? "unknown" })) ?? null,
    /** The latest-expiring of the app's client secrets, if the app may read itself. */
    secretExpires: secrets.length ? secrets.sort().at(-1)! : null,
  };
}
