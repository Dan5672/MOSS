// Amazon Web Services, read-only, with an IAM user's access key and the read-only policy shown on the integration's
// page. Requests are signed with Signature Version 4 here (no SDK). Most of these APIs answer in XML.
import { XMLParser } from "fast-xml-parser";
import { createHash, createHmac } from "node:crypto";
import { clean } from "./parsers.js";

export class AwsError extends Error {}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  /** Comma-separated region codes. */
  regions: string;
  timeoutMs: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Signature Version 4: the headers to send (Authorization, X-Amz-Date and, for S3, the payload hash). */
export function signV4(r: {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  body?: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
  payloadHeader?: boolean;
}): Record<string, string> {
  const amzDate = (r.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payload = sha256(r.body ?? "");
  const headers: Record<string, string> = { host: r.host, "x-amz-date": amzDate, ...(r.payloadHeader ? { "x-amz-content-sha256": payload } : {}) };
  const names = Object.keys(headers).sort();
  const query = Object.keys(r.query)
    .sort()
    .map((k) => `${enc(k)}=${enc(r.query[k]!)}`)
    .join("&");
  const canonical = [r.method, r.path.split("/").map(enc).join("/") || "/", query, ...names.map((n) => `${n}:${headers[n]}`), "", names.join(";"), payload].join("\n");
  const scope = `${day}/${r.region}/${r.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${r.secretAccessKey}`, day), r.region), r.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const { host: _host, ...rest } = headers;
  return { ...rest, Authorization: `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

// No entity processing: AWS never needs it, and it's a way to blow up or confuse a parser.
const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: false, isArray: (name) => ["item", "member", "DBInstance", "Bucket", "Grant", "entry"].includes(name) });
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : v && typeof v === "object" ? [v as Record<string, unknown>] : []);
const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
export function parseRegions(s: string): string[] {
  const regions = [...new Set(s.split(/[\s,]+/).filter(Boolean))];
  const bad = regions.filter((r) => !REGION.test(r));
  if (bad.length || !regions.length) throw new AwsError(`Not an AWS region: ${bad.join(", ") || "(none)"}`);
  return regions.slice(0, 10);
}

async function request(
  f: Fetch,
  a: Creds,
  p: { service: string; region: string; host: string; path?: string; query: Record<string, string>; s3?: boolean; optional?: boolean },
): Promise<Record<string, unknown> | null> {
  const path = p.path ?? "/";
  const headers = signV4({ method: "GET", host: p.host, path, query: p.query, service: p.service, region: p.region, accessKeyId: a.accessKeyId, secretAccessKey: a.secretAccessKey, payloadHeader: p.s3 });
  const qs = Object.entries(p.query)
    .map(([k, v]) => (v === "" ? enc(k) : `${enc(k)}=${enc(v)}`))
    .join("&");
  // The path is sent exactly as it was signed, and only ever to AWS.
  const url = new URL(`https://${p.host}${path.split("/").map(enc).join("/")}${qs ? `?${qs}` : ""}`);
  if (url.hostname !== p.host || !url.hostname.endsWith(".amazonaws.com")) throw new AwsError(`Refusing to send a request to ${p.host}`);
  const res = await f(url.toString(), { headers, signal: AbortSignal.timeout(a.timeoutMs) });
  const text = await res.text();
  if (res.status === 200) return text ? (xml.parse(text) as Record<string, unknown>) : {};
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP ${res.status}`;
  if (/InvalidClientTokenId|SignatureDoesNotMatch|AuthFailure|InvalidAccessKeyId/.test(code)) throw new AwsError(`AWS rejected the access key (${code})`);
  if (p.optional) return null;
  if (/AccessDenied|UnauthorizedOperation/.test(code)) throw new AwsError(`The access key isn't allowed ${p.service} ${p.query.Action ?? Object.keys(p.query)[0] ?? ""} (add it to the policy)`);
  throw new AwsError(`AWS ${p.service} in ${p.region} answered ${code}`);
}

const ec2 = (f: Fetch, a: Creds, region: string, action: string, extra: Record<string, string> = {}) =>
  request(f, a, { service: "ec2", region, host: `ec2.${region}.amazonaws.com`, query: { Action: action, Version: "2016-11-15", ...extra } });
const tag = (tags: unknown, key: string) => clean(list(o(tags).item).find((t) => t.key === key)?.value);

async function instances(f: Fetch, a: Creds, region: string) {
  const r = await ec2(f, a, region, "DescribeInstances", { MaxResults: "1000" });
  return list(o(o(o(r).DescribeInstancesResponse).reservationSet).item).flatMap((res) =>
    list(o(res.instancesSet).item).map((i) => ({
      id: clean(i.instanceId) ?? "",
      name: tag(i.tagSet, "Name"),
      type: clean(i.instanceType),
      state: clean(o(i.instanceState).name) ?? "unknown",
      privateIp: clean(i.privateIpAddress),
      publicIp: clean(i.ipAddress),
      platform: clean(i.platformDetails),
      groups: list(o(i.groupSet).item).map((g) => clean(g.groupId)).filter((g): g is string => !!g),
      region,
    })),
  );
}

async function databases(f: Fetch, a: Creds, region: string) {
  const r = await request(f, a, { service: "rds", region, host: `rds.${region}.amazonaws.com`, query: { Action: "DescribeDBInstances", Version: "2014-10-31" }, optional: true });
  return list(o(o(o(o(r).DescribeDBInstancesResponse).DescribeDBInstancesResult).DBInstances).DBInstance).map((d) => ({
    id: clean(d.DBInstanceIdentifier) ?? "",
    engine: clean(d.Engine),
    status: clean(d.DBInstanceStatus),
    public: d.PubliclyAccessible === "true",
    endpoint: clean(o(d.Endpoint).Address),
    region,
  }));
}

export async function awsInventory(a: Creds, f: Fetch = fetch as unknown as Fetch) {
  const regions = parseRegions(a.regions);
  const out = { instances: [] as Awaited<ReturnType<typeof instances>>, databases: [] as Awaited<ReturnType<typeof databases>> };
  for (const region of regions) {
    out.instances.push(...(await instances(f, a, region)));
    out.databases.push(...(await databases(f, a, region)));
  }
  return out;
}

export async function awsAlarms(a: Creds, f: Fetch = fetch as unknown as Fetch) {
  const alarms = [];
  for (const region of parseRegions(a.regions)) {
    const r = await request(f, a, { service: "monitoring", region, host: `monitoring.${region}.amazonaws.com`, query: { Action: "DescribeAlarms", Version: "2010-08-01", MaxRecords: "100" } });
    for (const m of list(o(o(o(o(r).DescribeAlarmsResponse).DescribeAlarmsResult).MetricAlarms).member)) {
      alarms.push({ name: clean(m.AlarmName) ?? "?", state: clean(m.StateValue) ?? "INSUFFICIENT_DATA", reason: clean(m.StateReason), region });
    }
  }
  return { alarms };
}

/** Ports that shouldn't be open to the whole internet. */
const SENSITIVE = new Map([
  [21, "FTP"],
  [22, "SSH"],
  [23, "Telnet"],
  [445, "SMB"],
  [1433, "SQL Server"],
  [3306, "MySQL"],
  [3389, "RDP"],
  [5432, "PostgreSQL"],
  [5900, "VNC"],
  [6379, "Redis"],
  [9200, "Elasticsearch"],
  [27017, "MongoDB"],
]);

export interface AwsFinding {
  /** Stable across checks, for "mark as expected". */
  key: string;
  resource: string;
  issue: string;
  region?: string;
}

export async function awsExposure(a: Creds, f: Fetch = fetch as unknown as Fetch) {
  const findings: AwsFinding[] = [];
  for (const region of parseRegions(a.regions)) {
    const inst = await instances(f, a, region);
    const sgs = await ec2(f, a, region, "DescribeSecurityGroups");
    const open = new Map<string, string[]>();
    for (const g of list(o(o(o(sgs).DescribeSecurityGroupsResponse).securityGroupInfo).item)) {
      const ports: string[] = [];
      for (const p of list(o(g.ipPermissions).item)) {
        const world = list(o(p.ipRanges).item).some((r) => r.cidrIp === "0.0.0.0/0") || list(o(p.ipv6Ranges).item).some((r) => r.cidrIpv6 === "::/0");
        if (!world) continue;
        if (p.ipProtocol === "-1") ports.push("every port");
        else {
          const from = Number(p.fromPort);
          const to = Number(p.toPort);
          for (const [port, name] of SENSITIVE) if (port >= from && port <= to) ports.push(`${name} (${port})`);
        }
      }
      if (ports.length) open.set(String(g.groupId), ports);
    }
    for (const i of inst.filter((x) => x.state === "running" && x.publicIp)) {
      const ports = [...new Set(i.groups.flatMap((g) => open.get(g) ?? []))];
      const label = i.name ? `${i.name} (${i.id})` : i.id;
      // The key names the ports, so newly opened ones on an instance already marked as expected are flagged again.
      if (ports.length) findings.push({ key: `sg:${i.id}:${[...ports].sort().join("+")}`, resource: label, issue: `Open to the internet on ${ports.join(", ")}`, region });
      else findings.push({ key: `ip:${i.id}`, resource: label, issue: `Has a public address (${i.publicIp})`, region });
    }
    for (const d of (await databases(f, a, region)).filter((x) => x.public)) findings.push({ key: `rds:${d.id}`, resource: `${d.id} (${d.engine ?? "database"})`, issue: "Publicly accessible database", region });
  }

  // S3 buckets: public by policy or ACL, unless the bucket blocks public access.
  const buckets = await request(f, a, { service: "s3", region: "us-east-1", host: "s3.amazonaws.com", query: {}, s3: true });
  for (const b of list(o(o(o(buckets).ListAllMyBucketsResult).Buckets).Bucket).slice(0, 100)) {
    const name = clean(b.Name);
    if (!name) continue;
    const loc = await request(f, a, { service: "s3", region: "us-east-1", host: "s3.amazonaws.com", path: `/${name}`, query: { location: "" }, s3: true, optional: true });
    // An empty location is us-east-1; "EU" is the old name for eu-west-1.
    const where = clean(o(loc).LocationConstraint);
    const region = !where ? "us-east-1" : where === "EU" ? "eu-west-1" : where;
    // The region becomes part of a host name: only a real region code, so an odd answer can't send requests elsewhere.
    if (!REGION.test(region)) continue;
    const at = (query: Record<string, string>) => request(f, a, { service: "s3", region, host: `s3.${region}.amazonaws.com`, path: `/${name}`, query, s3: true, optional: true });
    const block = o(o(await at({ publicAccessBlock: "" })).PublicAccessBlockConfiguration);
    if (block.RestrictPublicBuckets === "true" && block.IgnorePublicAcls === "true") continue;
    const policyPublic = o(o(await at({ policyStatus: "" })).PolicyStatus).IsPublic === "true";
    const aclPublic = list(o(o(o(await at({ acl: "" })).AccessControlPolicy).AccessControlList).Grant).some((g) => /AllUsers|AuthenticatedUsers/.test(String(o(g.Grantee).URI ?? "")));
    // The key names how it's public, so a bucket acknowledged as public by ACL is flagged again if its policy opens it too.
    const how = [policyPublic && "policy", aclPublic && "acl"].filter(Boolean).join("+");
    if (how) findings.push({ key: `s3:${name}:${how}`, resource: name, issue: `Public S3 bucket (${policyPublic ? "bucket policy" : "ACL"})`, region });
  }

  // The account: root MFA, root access keys, and access keys older than 90 days.
  const iam = (query: Record<string, string>) => request(f, a, { service: "iam", region: "us-east-1", host: "iam.amazonaws.com", query: { Version: "2010-05-08", ...query }, optional: true });
  const summary = list(o(o(o(o(await iam({ Action: "GetAccountSummary" })).GetAccountSummaryResponse).GetAccountSummaryResult).SummaryMap).entry);
  const value = (k: string) => clean(summary.find((e) => e.key === k)?.value);
  const account = { rootMfa: value("AccountMFAEnabled") === undefined ? null : value("AccountMFAEnabled") === "1", rootKeys: value("AccountAccessKeysPresent") === undefined ? null : value("AccountAccessKeysPresent") !== "0", oldKeys: [] as string[] };
  const users = list(o(o(o(o(await iam({ Action: "ListUsers", MaxItems: "100" })).ListUsersResponse).ListUsersResult).Users).member);
  for (const u of users) {
    const user = clean(u.UserName);
    if (!user) continue;
    const keys = list(o(o(o(o(await iam({ Action: "ListAccessKeys", UserName: user })).ListAccessKeysResponse).ListAccessKeysResult).AccessKeyMetadata).member);
    if (keys.some((k) => k.Status === "Active" && Date.now() - Date.parse(String(k.CreateDate)) > 90 * 86_400_000)) account.oldKeys.push(user);
  }
  return { findings, account };
}
