// Vulnerability scanning: nmap's safe/vuln scripts (and, when the owner allows it, the vulners CVE lookup),
// Nuclei's non-intrusive templates, and testssl.sh. Each binary gets a fixed argument list built from
// arguments the gate has already scope-checked; output is device data, cleaned and summarised here.
import { XMLParser } from "fast-xml-parser";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clean } from "./parsers.js";
import { ToolError, type Exec } from "./runners.js";

const TOP_PORTS = ["--top-ports", "100"];
/** nmap scripts: safe or vuln, never anything that could harm a device or talk to a third party. */
const SAFE_SCRIPTS = "(safe or vuln) and not (intrusive or dos or brute or exploit or fuzzer or broadcast or external)";
const CVE = /CVE-\d{4}-\d{4,7}/g;
const VULNERS_LINE = /(CVE-\d{4}-\d{4,7})\s+(\d+(?:\.\d+)?)/g;

export interface ScanFinding {
  script: string;
  vulnerable: boolean;
  cves: { id: string; cvss?: number }[];
  summary: string;
}

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function finding(script: Record<string, unknown>): ScanFinding {
  const id = clean(script["@_id"]) ?? "script";
  const output = String(script["@_output"] ?? "");
  const scored = [...output.matchAll(VULNERS_LINE)].map((m) => ({ id: m[1]!, cvss: Number(m[2]) }));
  const ids = [...new Set(output.match(CVE) ?? [])];
  const listed: { id: string; cvss?: number }[] = scored.length ? scored : ids.map((id) => ({ id }));
  const cves = listed.sort((a, b) => (b.cvss ?? 0) - (a.cvss ?? 0)).slice(0, 25);
  return { script: id, vulnerable: /\bVULNERABLE\b/.test(output) && !/NOT VULNERABLE/.test(output), cves, summary: (clean(output) ?? "").slice(0, 600) };
}

export function parseVulnScan(xml: string) {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml) as Record<string, unknown>;
  const host = arr((doc.nmaprun as Record<string, unknown> | undefined)?.host as Record<string, unknown> | Record<string, unknown>[])[0];
  if (!host) return { up: false, ports: [], hostFindings: [] };
  const ports = arr((host.ports as Record<string, unknown> | undefined)?.port as Record<string, unknown>[] | Record<string, unknown>)
    .filter((p) => (p.state as Record<string, unknown> | undefined)?.["@_state"] === "open")
    .map((p) => {
      const svc = (p.service ?? {}) as Record<string, unknown>;
      return {
        port: Number(p["@_portid"]),
        protocol: clean(p["@_protocol"]),
        service: clean(svc["@_name"]),
        product: clean(svc["@_product"]),
        version: clean(svc["@_version"]),
        findings: arr(p.script as Record<string, unknown>[] | Record<string, unknown>).map(finding).filter((f) => f.vulnerable || f.cves.length || f.summary),
      };
    });
  const hostFindings = arr((host.hostscript as Record<string, unknown> | undefined)?.script as Record<string, unknown>[] | Record<string, unknown>).map(finding);
  return { up: true, ports, hostFindings };
}

export async function vulnScan(a: { target: string; profile: "safe" | "cve"; ports?: number[] }, exec: Exec) {
  const ports = a.ports?.length ? ["-p", a.ports.join(",")] : TOP_PORTS;
  const scripts = a.profile === "cve" ? ["--script", "vulners", "--script-args", "mincvss=4.0"] : ["--script", SAFE_SCRIPTS];
  const res = await exec("nmap", ["-sV", "-Pn", "-T3", "--host-timeout", "10m", ...ports, ...scripts, "-oX", "-", a.target], 12 * 60_000);
  if (res.code !== 0 && !res.stdout.includes("<nmaprun")) throw new ToolError(`nmap failed: ${res.stderr.slice(0, 500)}`);
  const parsed = parseVulnScan(res.stdout);
  const all = [...parsed.hostFindings, ...parsed.ports.flatMap((p) => p.findings)];
  return {
    target: a.target,
    profile: a.profile,
    ...parsed,
    summary: {
      openPorts: parsed.ports.length,
      vulnerable: all.filter((f) => f.vulnerable).length,
      cves: [...new Set(all.flatMap((f) => f.cves.map((c) => c.id)))].length,
      highestCvss: Math.max(0, ...all.flatMap((f) => f.cves.map((c) => c.cvss ?? 0))),
    },
  };
}

// --- Nuclei ---------------------------------------------------------------------------------------

export const NUCLEI_TEMPLATES = "/opt/nuclei-templates";
/** Never run: anything that could disrupt, guess passwords, fuzz, or log in with default credentials. */
const NUCLEI_EXCLUDED_TAGS = ["dos", "intrusive", "fuzz", "fuzzing", "bruteforce", "brute-force", "default-login", "rce", "sqli"];

export function parseNuclei(jsonl: string) {
  const findings = jsonl
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .map((r) => {
      const info = (r.info ?? {}) as Record<string, unknown>;
      const cls = (info.classification ?? {}) as Record<string, unknown>;
      return {
        template: clean(r["template-id"]),
        name: clean(info.name),
        severity: clean(info.severity) ?? "unknown",
        matchedAt: clean(r["matched-at"]),
        cves: arr(cls["cve-id"] as string[] | string).map((c) => clean(c)!).filter(Boolean),
        description: (clean(info.description) ?? "").slice(0, 300),
      };
    });
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return { counts, findings: findings.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)).slice(0, 100) };
}

export async function nucleiScan(a: { target: string; ports?: number[]; severity: string[] }, exec: Exec) {
  const ports = a.ports?.length ? a.ports : [80, 443];
  const res = await exec(
    "nuclei",
    [
      ...ports.flatMap((p) => ["-u", `${a.target}:${p}`]),
      "-t", NUCLEI_TEMPLATES,
      "-pt", "http,tcp,ssl,dns",
      "-severity", a.severity.join(","),
      "-etags", NUCLEI_EXCLUDED_TAGS.join(","),
      "-ni", // no interactsh: no out-of-band callbacks to outside servers
      "-duc", // no update checks
      "-rl", "50",
      "-c", "10",
      "-timeout", "5",
      "-jsonl",
      "-silent",
      "-nc",
    ],
    15 * 60_000,
  );
  if (res.code !== 0 && !res.stdout.trim()) throw new ToolError(`nuclei failed: ${res.stderr.slice(-500)}`);
  return { target: a.target, ports, severity: a.severity, ...parseNuclei(res.stdout) };
}

// --- testssl.sh -----------------------------------------------------------------------------------

export function parseTestssl(json: string) {
  let rows: Record<string, unknown>[];
  try {
    const raw = JSON.parse(json) as unknown;
    rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : (((raw as Record<string, unknown>).scanResult as Record<string, unknown>[] | undefined) ?? []);
  } catch {
    throw new ToolError("testssl.sh's report wasn't readable");
  }
  const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "WARN"];
  const findings = rows
    .map((r) => ({ id: clean(r.id), severity: (clean(r.severity) ?? "INFO").toUpperCase(), finding: (clean(r.finding) ?? "").slice(0, 300), cve: clean(r.cve) }))
    .filter((f) => order.includes(f.severity))
    .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
    .slice(0, 80);
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  const cert = rows.find((r) => r.id === "cert_notAfter");
  const protocols = rows.filter((r) => /^(SSLv2|SSLv3|TLS1|TLS1_1|TLS1_2|TLS1_3)$/.test(String(r.id))).map((r) => ({ protocol: clean(r.id), offered: clean(r.finding) }));
  return { counts, findings, certificateExpires: clean(cert?.finding), protocols };
}

export async function tlsAudit(a: { target: string; port: number; hostname?: string }, exec: Exec, read: (path: string) => Promise<string> = (p) => readFile(p, "utf8")) {
  const dir = await mkdtemp(join(tmpdir(), "testssl-"));
  const out = join(dir, "report.json");
  try {
    // With a hostname, testssl presents it (SNI) but still connects only to the scoped IP.
    const where = a.hostname ? ["--ip", a.target, `${a.hostname}:${a.port}`] : [`${a.target}:${a.port}`];
    const res = await exec("testssl", ["--quiet", "--color", "0", "--warnings", "batch", "--sneaky", "--jsonfile", out, ...where], 8 * 60_000);
    const report = await read(out).catch(() => "");
    if (!report) throw new ToolError(`testssl.sh produced no report: ${(res.stderr || res.stdout).slice(-400)}`);
    return { target: a.target, port: a.port, hostname: a.hostname ?? null, ...parseTestssl(report) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
