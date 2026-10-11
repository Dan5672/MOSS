// AWS: Signature Version 4 against AWS's published test vector, and the read-only calls against stand-in XML.
import { describe, expect, it } from "vitest";
import { awsAlarms, awsExposure, awsInventory, parseRegions, signV4 } from "./aws.js";

describe("Signature Version 4", () => {
  it("matches AWS's get-vanilla test vector", () => {
    const h = signV4({
      method: "GET",
      host: "example.amazonaws.com",
      path: "/",
      query: {},
      service: "service",
      region: "us-east-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(h).toEqual({
      "x-amz-date": "20150830T123600Z",
      Authorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    });
  });

  it("checks regions", () => {
    expect(parseRegions("ap-southeast-2, us-east-1 us-east-1")).toEqual(["ap-southeast-2", "us-east-1"]);
    expect(() => parseRegions("mars-1")).toThrow("Not an AWS region: mars-1");
  });
});

/** A stand-in AWS: answers by host and the request's Action (or S3 sub-resource). */
function aws(routes: Record<string, string>, status: Record<string, number> = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    const u = new URL(url);
    const key = `${u.host}${u.pathname} ${u.searchParams.get("Action") ?? [...u.searchParams.keys()].join(",")}`.trim();
    calls.push(key);
    expect(init?.headers?.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST/);
    const code = status[key];
    return { status: code ?? (key in routes ? 200 : 404), text: async () => (code ? `<Error><Code>AccessDenied</Code></Error>` : (routes[key] ?? "<Error><Code>NotFound</Code></Error>")) };
  };
  return { fetchImpl, calls };
}

const creds = { accessKeyId: "AKIATEST", secretAccessKey: "s3cret", regions: "ap-southeast-2", timeoutMs: 5000 };
const INSTANCES = `<DescribeInstancesResponse><reservationSet><item><instancesSet>
  <item><instanceId>i-web</instanceId><instanceType>t3.small</instanceType><instanceState><name>running</name></instanceState>
    <privateIpAddress>10.0.1.5</privateIpAddress><ipAddress>203.0.113.10</ipAddress>
    <tagSet><item><key>Name</key><value>web</value></item></tagSet><groupSet><item><groupId>sg-open</groupId></item></groupSet></item>
  <item><instanceId>i-app</instanceId><instanceState><name>running</name></instanceState><ipAddress>203.0.113.11</ipAddress>
    <groupSet><item><groupId>sg-web</groupId></item></groupSet></item>
  <item><instanceId>i-off</instanceId><instanceState><name>stopped</name></instanceState></item>
</instancesSet></item></reservationSet></DescribeInstancesResponse>`;
const RDS = `<DescribeDBInstancesResponse><DescribeDBInstancesResult><DBInstances><DBInstance><DBInstanceIdentifier>orders</DBInstanceIdentifier><Engine>postgres</Engine>
  <DBInstanceStatus>available</DBInstanceStatus><PubliclyAccessible>true</PubliclyAccessible></DBInstance></DBInstances></DBInstancesResult></DescribeDBInstancesResponse>`.replace("</DBInstancesResult>", "</DescribeDBInstancesResult>");

describe("AWS", () => {
  it("lists instances and databases per region", async () => {
    const { fetchImpl } = aws({ "ec2.ap-southeast-2.amazonaws.com/ DescribeInstances": INSTANCES, "rds.ap-southeast-2.amazonaws.com/ DescribeDBInstances": RDS });
    const res = await awsInventory(creds, fetchImpl);
    expect(res.instances.map((i) => [i.id, i.name, i.state, i.privateIp, i.publicIp, i.groups])).toEqual([
      ["i-web", "web", "running", "10.0.1.5", "203.0.113.10", ["sg-open"]],
      ["i-app", undefined, "running", undefined, "203.0.113.11", ["sg-web"]],
      ["i-off", undefined, "stopped", undefined, undefined, []],
    ]);
    expect(res.databases).toEqual([{ id: "orders", engine: "postgres", status: "available", public: true, endpoint: undefined, region: "ap-southeast-2" }]);
  });

  it("finds what the internet can reach, and the account's weak spots", async () => {
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const { fetchImpl, calls } = aws({
      "ec2.ap-southeast-2.amazonaws.com/ DescribeInstances": INSTANCES,
      "ec2.ap-southeast-2.amazonaws.com/ DescribeSecurityGroups": `<DescribeSecurityGroupsResponse><securityGroupInfo>
        <item><groupId>sg-open</groupId><ipPermissions>
          <item><ipProtocol>tcp</ipProtocol><fromPort>22</fromPort><toPort>22</toPort><ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges></item>
          <item><ipProtocol>tcp</ipProtocol><fromPort>3300</fromPort><toPort>3400</toPort><ipv6Ranges><item><cidrIpv6>::/0</cidrIpv6></item></ipv6Ranges></item>
        </ipPermissions></item>
        <item><groupId>sg-web</groupId><ipPermissions><item><ipProtocol>tcp</ipProtocol><fromPort>443</fromPort><toPort>443</toPort><ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges></item></ipPermissions></item>
      </securityGroupInfo></DescribeSecurityGroupsResponse>`,
      "rds.ap-southeast-2.amazonaws.com/ DescribeDBInstances": RDS,
      "s3.amazonaws.com/": `<ListAllMyBucketsResult><Buckets><Bucket><Name>site-assets</Name></Bucket><Bucket><Name>backups</Name></Bucket><Bucket><Name>odd</Name></Bucket></Buckets></ListAllMyBucketsResult>`,
      "s3.amazonaws.com/site-assets location": `<LocationConstraint>ap-southeast-2</LocationConstraint>`,
      "s3.ap-southeast-2.amazonaws.com/site-assets policyStatus": `<PolicyStatus><IsPublic>true</IsPublic></PolicyStatus>`,
      "s3.amazonaws.com/backups location": `<LocationConstraint></LocationConstraint>`,
      // A location that isn't a region must never become a host to call.
      "s3.amazonaws.com/odd location": `<LocationConstraint>attacker.test/x</LocationConstraint>`,
      "s3.us-east-1.amazonaws.com/backups publicAccessBlock": `<PublicAccessBlockConfiguration><IgnorePublicAcls>true</IgnorePublicAcls><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>`,
      "iam.amazonaws.com/ GetAccountSummary": `<GetAccountSummaryResponse><GetAccountSummaryResult><SummaryMap><entry><key>AccountMFAEnabled</key><value>0</value></entry><entry><key>AccountAccessKeysPresent</key><value>1</value></entry></SummaryMap></GetAccountSummaryResult></GetAccountSummaryResponse>`,
      "iam.amazonaws.com/ ListUsers": `<ListUsersResponse><ListUsersResult><Users><member><UserName>ci</UserName></member></Users></ListUsersResult></ListUsersResponse>`,
      "iam.amazonaws.com/ ListAccessKeys": `<ListAccessKeysResponse><ListAccessKeysResult><AccessKeyMetadata><member><Status>Active</Status><CreateDate>${old}</CreateDate></member></AccessKeyMetadata></ListAccessKeysResult></ListAccessKeysResponse>`,
    });
    const res = await awsExposure(creds, fetchImpl);
    expect(res.findings).toEqual([
      { key: "sg:i-web:MySQL (3306)+RDP (3389)+SSH (22)", resource: "web (i-web)", issue: "Open to the internet on SSH (22), MySQL (3306), RDP (3389)", region: "ap-southeast-2" },
      { key: "ip:i-app", resource: "i-app", issue: "Has a public address (203.0.113.11)", region: "ap-southeast-2" },
      { key: "rds:orders", resource: "orders (postgres)", issue: "Publicly accessible database", region: "ap-southeast-2" },
      { key: "s3:site-assets", resource: "site-assets", issue: "Public S3 bucket (bucket policy)", region: "ap-southeast-2" },
    ]);
    expect(res.account).toEqual({ rootMfa: false, rootKeys: true, oldKeys: ["ci"] });
    expect(calls.filter((c) => c.includes("attacker"))).toEqual([]);
  });

  it("reads CloudWatch alarms, and says plainly what the key isn't allowed", async () => {
    const { fetchImpl } = aws({
      "monitoring.ap-southeast-2.amazonaws.com/ DescribeAlarms": `<DescribeAlarmsResponse><DescribeAlarmsResult><MetricAlarms><member><AlarmName>web CPU</AlarmName><StateValue>ALARM</StateValue><StateReason>Threshold crossed</StateReason></member></MetricAlarms></DescribeAlarmsResult></DescribeAlarmsResponse>`,
    });
    expect((await awsAlarms(creds, fetchImpl)).alarms).toEqual([{ name: "web CPU", state: "ALARM", reason: "Threshold crossed", region: "ap-southeast-2" }]);
    const denied = aws({}, { "monitoring.ap-southeast-2.amazonaws.com/ DescribeAlarms": 403 });
    await expect(awsAlarms(creds, denied.fetchImpl)).rejects.toThrow("The access key isn't allowed monitoring DescribeAlarms (add it to the policy)");
  });
});
