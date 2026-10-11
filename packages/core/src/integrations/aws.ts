// Amazon Web Services (business), read-only. Inventory: EC2 instances and RDS databases, matched by their own id
// only (a VPC's private addresses can repeat the office network's, so they never match by IP). Health: CloudWatch
// alarms, an exposure report of what the internet can reach (new findings make it degraded until marked as
// expected, like Cloudflare's), and the account's weak spots.
import type { ParsedAlert } from "../monitoring/webhooks.js";
import type { FeatureOutput, IntegrationConfig, IntegrationDef } from "./types.js";

interface Inventory {
  instances: { id: string; name?: string; type?: string; state: string; privateIp?: string; publicIp?: string; platform?: string; region: string }[];
  databases: { id: string; engine?: string; status?: string; public: boolean; endpoint?: string; region: string }[];
}
export interface AwsFinding {
  key: string;
  resource: string;
  issue: string;
  region?: string;
}
interface Exposure {
  findings: AwsFinding[];
  account: { rootMfa: boolean | null; rootKeys: boolean | null; oldKeys: string[] };
}

/** What the exposure report last found, for the integration's page. */
export interface AwsState {
  exposure?: { at: string; findings: AwsFinding[] };
}

export function awsAcknowledged(c: IntegrationConfig): string[] {
  const v = c.options.acknowledged;
  return Array.isArray(v) ? v.map(String) : [];
}

export function awsInventoryOutput(r: Inventory): FeatureOutput {
  return {
    inventory: [
      ...r.instances
        .filter((i) => i.state !== "terminated")
        .map((i) => ({
          externalId: `aws:${i.id}`,
          name: i.name ?? i.id,
          kind: "vm",
          vendor: "AWS",
          ...(i.type ? { model: i.type } : {}),
          ...(i.platform ? { os: i.platform } : {}),
          ips: [],
          macs: [],
          createWithoutIp: true,
          details: { region: i.region, state: i.state, privateIp: i.privateIp, publicIp: i.publicIp },
        })),
      ...r.databases.map((d) => ({
        externalId: `aws:rds:${d.id}`,
        name: d.id,
        kind: "database",
        vendor: "AWS",
        ...(d.engine ? { model: d.engine } : {}),
        ips: [],
        macs: [],
        createWithoutIp: true,
        details: { region: d.region, status: d.status, public: d.public, endpoint: d.endpoint },
      })),
    ],
    summary: `${r.instances.length} instance(s), ${r.databases.length} database(s)`,
  };
}

export function awsAlarmsHealth(r: { alarms: { name: string; state: string; reason?: string; region: string }[] }): FeatureOutput {
  const alerts: ParsedAlert[] = r.alarms.map((a) => ({
    key: `alarm:${a.region}:${a.name}`,
    name: `AWS ${a.name}`,
    status: a.state === "ALARM" ? "down" : a.state === "OK" ? "up" : "degraded",
    message: `${a.state}${a.reason ? `: ${a.reason}` : ""}`.slice(0, 500),
  }));
  return { alerts, summary: `${r.alarms.filter((a) => a.state === "ALARM").length} of ${r.alarms.length} alarm(s) firing` };
}

export function awsExposureHealth(r: Exposure, c: IntegrationConfig, now: Date): FeatureOutput {
  const known = new Set(awsAcknowledged(c));
  const fresh = r.findings.filter((f) => !known.has(f.key));
  const alerts: ParsedAlert[] = [
    {
      key: "exposure",
      name: "AWS exposure",
      status: fresh.length ? "degraded" : "up",
      message: fresh.length
        ? `New: ${fresh
            .slice(0, 5)
            .map((f) => `${f.resource}: ${f.issue}`)
            .join("; ")}${fresh.length > 5 ? ` and ${fresh.length - 5} more` : ""}. Check, then mark them as expected in Settings → Integrations → AWS.`
        : `${r.findings.length} finding(s), all expected`,
      value: r.findings.length,
    },
  ];
  if (r.account.rootMfa !== null) {
    alerts.push({ key: "root-mfa", name: "AWS root account MFA", status: r.account.rootMfa ? "up" : "down", message: r.account.rootMfa ? "The root account has MFA" : "The root account has no MFA: turn it on" });
  }
  if (r.account.rootKeys !== null) {
    alerts.push({ key: "root-keys", name: "AWS root access keys", status: r.account.rootKeys ? "down" : "up", message: r.account.rootKeys ? "The root account has access keys: delete them and use IAM users or roles" : "The root account has no access keys" });
  }
  alerts.push({
    key: "old-keys",
    name: "AWS access keys older than 90 days",
    status: r.account.oldKeys.length ? "degraded" : "up",
    message: r.account.oldKeys.length ? `Rotate the keys of ${r.account.oldKeys.slice(0, 10).join(", ")}` : "No active key is older than 90 days",
  });
  return { alerts, summary: `${r.findings.length} exposure finding(s)${fresh.length ? `, ${fresh.length} new` : ""}`, state: { exposure: { at: now.toISOString(), findings: r.findings } } satisfies AwsState };
}

/** The read-only policy MOSS needs, shown on the setup page. */
export const AWS_POLICY = JSON.stringify(
  {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "MossReadOnly",
        Effect: "Allow",
        Action: [
          "ec2:DescribeInstances",
          "ec2:DescribeSecurityGroups",
          "rds:DescribeDBInstances",
          "cloudwatch:DescribeAlarms",
          "s3:ListAllMyBuckets",
          "s3:GetBucketLocation",
          "s3:GetBucketPolicyStatus",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketAcl",
          "iam:GetAccountSummary",
          "iam:ListUsers",
          "iam:ListAccessKeys",
        ],
        Resource: "*",
      },
    ],
  },
  null,
  2,
);

export const AWS: IntegrationDef = {
  key: "aws",
  name: "AWS",
  description: "EC2 instances and RDS databases in the inventory, CloudWatch alarms watched, and know what the internet can reach in your account. Read-only.",
  plan: "business",
  connection: {
    defaultPort: 443,
    cloud: true,
    fields: [
      { key: "accessKeyId", label: "Access key ID", hint: "Of an IAM user with only the policy below.", pattern: "^(AKIA|ASIA)[A-Z0-9]{16}$", message: "An access key ID (AKIA followed by 16 letters and digits)" },
      { key: "regions", label: "Regions", hint: "Comma-separated, up to 10, e.g. ap-southeast-2, us-east-1.", pattern: "^[a-z]{2}(-gov)?-[a-z]+-\\d(\\s*,\\s*[a-z]{2}(-gov)?-[a-z]+-\\d){0,9}$", message: "AWS region codes, e.g. ap-southeast-2" },
    ],
    hint: "In IAM, create a user for MOSS with no console access, attach a policy with only the read-only actions below, and create an access key for it.",
  },
  credential: {
    secretName: "aws-secret-access-key",
    type: "api_token",
    arg: "secretAccessKey",
    label: "Secret access key",
    hint: "Shown once when you create the access key.",
    tools: ["aws_inventory", "aws_alarms", "aws_exposure"],
  },
  test: {
    op: "inventory",
    describe: (r) => {
      const i = r as Inventory;
      return `Connected to AWS: ${i.instances.length} instance(s), ${i.databases.length} database(s).`;
    },
  },
  ops: { inventory: { tool: "aws_inventory" }, alarms: { tool: "aws_alarms" }, exposure: { tool: "aws_exposure" } },
  features: [
    {
      key: "inventory",
      label: "Instances and databases in the inventory",
      description: "Every 6 hours: EC2 instances and RDS databases, matched by their AWS id (never by address).",
      everyMs: 6 * 60 * 60_000,
      op: "inventory",
      apply: (r) => awsInventoryOutput(r as Inventory),
    },
    {
      key: "alarms",
      label: "CloudWatch alarms",
      description: "Every 5 minutes: each CloudWatch alarm as a monitor, down while it's in ALARM.",
      everyMs: 5 * 60_000,
      op: "alarms",
      apply: (r) => awsAlarmsHealth(r as { alarms: { name: string; state: string; reason?: string; region: string }[] }),
    },
    {
      key: "exposure",
      label: "Exposure report and account checks",
      description:
        "Every hour: instances with public addresses, security groups open to the world on sensitive ports, public S3 buckets and databases (new ones make the monitor degraded until marked as expected), and the root account's MFA and access keys, and access keys older than 90 days.",
      everyMs: 60 * 60_000,
      op: "exposure",
      apply: (r, { config, now }) => awsExposureHealth(r as Exposure, config, now),
    },
  ],
  agentTools: ["aws_inventory", "aws_alarms", "aws_exposure"],
};
