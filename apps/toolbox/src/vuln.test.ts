import { describe, expect, it } from "vitest";
import { runTool, type Exec } from "./runners.js";
import { parseNuclei, parseTestssl, parseVulnScan, tlsAudit } from "./vuln.js";

const NMAP_XML = `<?xml version="1.0"?>
<nmaprun><host><status state="up"/><address addr="10.0.0.5" addrtype="ipv4"/>
<ports>
<port protocol="tcp" portid="22"><state state="open"/><service name="ssh" product="OpenSSH" version="8.2p1"/>
<script id="vulners" output="cpe:/a:openbsd:openssh:8.2p1: &#xa;  CVE-2023-38408 9.8 https://vulners.com/cve/CVE-2023-38408&#xa;  CVE-2020-15778 6.8 https://vulners.com/cve/CVE-2020-15778"/></port>
<port protocol="tcp" portid="443"><state state="open"/><service name="https"/>
<script id="ssl-dh-params" output="VULNERABLE:&#xa;  Diffie-Hellman Key Exchange Insufficient Group Strength"/></port>
<port protocol="tcp" portid="8080"><state state="closed"/><service name="http-proxy"/></port>
</ports></host></nmaprun>`;

/** A fake exec that records what was run and answers with canned output. */
function fakeExec(stdout: string, code = 0) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    return { stdout, stderr: "", code };
  };
  return { exec, calls };
}

describe("vuln_scan", () => {
  it("parses open ports, vulnerable scripts and CVEs ranked by score", () => {
    const r = parseVulnScan(NMAP_XML);
    expect(r.ports.map((p) => p.port)).toEqual([22, 443]);
    expect(r.ports[0]!.findings[0]!.cves).toEqual([
      { id: "CVE-2023-38408", cvss: 9.8 },
      { id: "CVE-2020-15778", cvss: 6.8 },
    ]);
    expect(r.ports[1]!.findings[0]).toMatchObject({ script: "ssl-dh-params", vulnerable: true });
  });

  it("runs only safe scripts unless the CVE lookup is asked for, against the one target", async () => {
    const { exec, calls } = fakeExec(NMAP_XML);
    const safe = (await runTool("vuln_scan", { target: "10.0.0.5" }, exec)) as { summary: Record<string, number> };
    const script = calls[0]!.args[calls[0]!.args.indexOf("--script") + 1]!;
    expect(script).toContain("not (intrusive or dos or brute or exploit or fuzzer or broadcast or external)");
    expect(calls[0]!.args.at(-1)).toBe("10.0.0.5");
    expect(safe.summary).toMatchObject({ openPorts: 2, vulnerable: 1, cves: 2, highestCvss: 9.8 });
    await runTool("vuln_scan", { target: "10.0.0.5", profile: "cve", ports: [22] }, exec);
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["--script", "vulners", "-p", "22"]));
    await expect(runTool("vuln_scan", { target: "10.0.0.0/24" }, exec)).rejects.toThrow();
  });
});

describe("nuclei_scan", () => {
  it("runs with intrusive templates excluded and no callbacks, and summarises findings by severity", async () => {
    const out = [
      JSON.stringify({ "template-id": "exposed-panel", info: { name: "Admin panel", severity: "medium" }, "matched-at": "http://10.0.0.5:8080/admin" }),
      JSON.stringify({ "template-id": "cve-2021-1234", info: { name: "Old thing", severity: "critical", classification: { "cve-id": ["CVE-2021-1234"] } }, "matched-at": "10.0.0.5:443" }),
      "not json",
    ].join("\n");
    const { exec, calls } = fakeExec(out);
    const r = (await runTool("nuclei_scan", { target: "10.0.0.5", ports: [443, 8080] }, exec)) as ReturnType<typeof parseNuclei>;
    const args = calls[0]!.args;
    expect(args).toEqual(expect.arrayContaining(["-u", "10.0.0.5:443", "-u", "10.0.0.5:8080", "-ni", "-duc", "-severity", "medium,high,critical"]));
    expect(args[args.indexOf("-etags") + 1]).toContain("dos");
    expect(args[args.indexOf("-etags") + 1]).toContain("default-login");
    expect(r.counts).toEqual({ medium: 1, critical: 1 });
    expect(r.findings[0]).toMatchObject({ severity: "critical", cves: ["CVE-2021-1234"] });
  });
});

describe("tls_audit", () => {
  const REPORT = JSON.stringify([
    { id: "TLS1", severity: "LOW", finding: "offered (deprecated)" },
    { id: "TLS1_3", severity: "OK", finding: "offered with final" },
    { id: "cert_notAfter", severity: "OK", finding: "2026-12-01 10:00" },
    { id: "heartbleed", severity: "OK", finding: "not vulnerable" },
    { id: "cipherlist_3DES_IDEA", severity: "MEDIUM", finding: "offered", cve: "CVE-2016-2183" },
  ]);

  it("keeps the problems, the protocols and the certificate's expiry", () => {
    const r = parseTestssl(REPORT);
    expect(r.findings.map((f) => f.id)).toEqual(["cipherlist_3DES_IDEA", "TLS1"]);
    expect(r.certificateExpires).toBe("2026-12-01 10:00");
    expect(r.protocols).toContainEqual({ protocol: "TLS1", offered: "offered (deprecated)" });
  });

  it("presents the hostname but connects only to the scoped IP", async () => {
    const { exec, calls } = fakeExec("");
    const r = await tlsAudit({ target: "10.0.0.5", port: 8443, hostname: "nas.lan" }, exec, async () => REPORT);
    expect(calls[0]!.args.slice(-3)).toEqual(["--ip", "10.0.0.5", "nas.lan:8443"]);
    expect(r).toMatchObject({ target: "10.0.0.5", port: 8443, counts: { MEDIUM: 1, LOW: 1 } });
  });
});
