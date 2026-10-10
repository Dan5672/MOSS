// Checking an uploaded HTTPS certificate before MOSS uses it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { certificateReminderDue, checkCertificate, httpsHostList } from "./services/certificates.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url), "utf8");
const server = fixture("server.crt");
const ca = fixture("ca.crt");
const key = fixture("server.key");

describe("uploaded certificates", () => {
  it("accepts a matching key and chain, and says which names it covers", () => {
    const c = checkCertificate(server + ca, key, httpsHostList("localhost, moss.test, 10.0.0.5, other.lan"));
    expect(c.subject).toContain("CN=moss.test");
    expect(c.covers).toEqual(["moss.test", "10.0.0.5"]);
    expect(c.missing).toEqual(["other.lan"]);
    expect(c.warnings.join(" ")).toMatch(/doesn't cover other.lan/);
    expect(c.warnings).toHaveLength(1);
    expect(checkCertificate(server, key, ["moss.test"]).warnings.join(" ")).toMatch(/Only the server's certificate was uploaded/);
    expect(c.certPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(c.keyPem).toContain("BEGIN PRIVATE KEY");
  });

  it("takes the key from a file that also holds the certificates", () => {
    const both = `Bag Attributes\n${server}${ca}${key}`;
    expect(checkCertificate(both, both, ["moss.test"]).covers).toEqual(["moss.test"]);
  });

  it("refuses what would break HTTPS", () => {
    const hosts = ["moss.test"];
    expect(() => checkCertificate("hello", key, hosts)).toThrow(/isn't a PEM certificate/);
    expect(() => checkCertificate(server, fixture("other.key"), hosts)).toThrow(/doesn't belong/);
    expect(() => checkCertificate(server, "nonsense", hosts)).toThrow(/couldn't be read/);
    expect(() => checkCertificate(ca + server, key, hosts)).toThrow(/doesn't belong|certificate authority/);
    expect(() => checkCertificate(server, key, ["elsewhere.lan"])).toThrow(/doesn't cover any/);
    expect(() => checkCertificate(server, key, hosts, new Date("2200-01-01"))).toThrow(/expired/);
    expect(() => checkCertificate(server + server, key, hosts)).toThrow(/out of order/);
  });

  it("reminds 30 and then 7 days before it runs out", () => {
    const info = { subject: "CN=x", fingerprint: "AA", notAfter: "2030-02-01T00:00:00Z" };
    expect(certificateReminderDue(info, new Date("2029-12-01"))).toBeNull();
    expect(certificateReminderDue(info, new Date("2030-01-05"))).toBe(30);
    expect(certificateReminderDue({ ...info, reminded: [30] }, new Date("2030-01-05"))).toBeNull();
    expect(certificateReminderDue({ ...info, reminded: [30] }, new Date("2030-01-28"))).toBe(7);
  });
});
