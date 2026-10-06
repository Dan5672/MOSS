// Server checks over SSH. Each tool runs one fixed, read-only command; the only agent-supplied value that
// reaches the remote shell is a service name already restricted to [A-Za-z0-9@._:-]. Logins use a private
// key (never a password). The server's host key fingerprint is computed here, reported, and checked
// against a pin when one is given.
import { createHash } from "node:crypto";
import { Client } from "ssh2";
import { clean } from "./parsers.js";

export class ServerError extends Error {}

export interface SshTarget {
  target: string;
  user: string;
  key: string;
  port: number;
  hostKeySha256?: string;
  timeoutMs: number;
}

export interface SshResult {
  stdout: string;
  stderr: string;
  code: number | null;
  hostKeySha256: string;
}

export type SshRun = (t: SshTarget, command: string) => Promise<SshResult>;

const MAX_OUTPUT = 1024 * 1024;
const fingerprint = (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
const normalizePin = (pin: string) => (pin.startsWith("SHA256:") ? pin : `SHA256:${pin}`).replace(/=+$/, "");

export const sshRun: SshRun = (t, command) =>
  new Promise((resolve, reject) => {
    const conn = new Client();
    let seen = "";
    let mismatch = false;
    const timer = setTimeout(() => {
      conn.end();
      reject(new ServerError(`No answer from ${t.target} within ${t.timeoutMs} ms`));
    }, t.timeoutMs + 2000);
    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            return reject(new ServerError(`Could not run the check: ${err.message}`));
          }
          let stdout = "";
          let stderr = "";
          stream.on("data", (d: Buffer) => (stdout = (stdout + d.toString("utf8")).slice(0, MAX_OUTPUT)));
          stream.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(0, 8192)));
          stream.on("close", (code: number | null) => {
            clearTimeout(timer);
            conn.end();
            resolve({ stdout, stderr, code, hostKeySha256: seen });
          });
        });
      })
      .on("error", (err) => {
        clearTimeout(timer);
        if (mismatch) return reject(new ServerError(`Host key mismatch for ${t.target}: the server presented ${seen}, not the pinned fingerprint. Refusing to log in.`));
        const msg = /authentication/i.test(err.message) ? `${t.user}@${t.target} refused the key` : err.message;
        reject(new ServerError(`SSH to ${t.target} failed: ${msg}`));
      })
      .connect({
        host: t.target,
        port: t.port,
        username: t.user,
        privateKey: t.key,
        readyTimeout: t.timeoutMs,
        // Keys only: no password or keyboard-interactive fallback.
        tryKeyboard: false,
        hostVerifier: (key: Buffer) => {
          seen = fingerprint(key);
          if (t.hostKeySha256 && seen !== normalizePin(t.hostKeySha256)) {
            mismatch = true;
            return false;
          }
          return true;
        },
      });
  });

async function run(t: SshTarget, command: string, ssh: SshRun) {
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t.key)) throw new ServerError("The secret isn't an SSH private key (only key-based logins are supported)");
  const res = await ssh(t, command);
  return res;
}

const pinNote = (t: SshTarget, seen: string) => ({
  hostKeySha256: seen,
  ...(t.hostKeySha256 ? {} : { note: "Host key not pinned. Record this fingerprint (after checking it on the server) and pass it as hostKeySha256." }),
});

// --- host_facts ----------------------------------------------------------------------------------

const FACTS_COMMAND =
  "uname -srm; echo @@; hostname; echo @@; cat /etc/os-release 2>/dev/null; echo @@; cat /proc/uptime; echo @@; nproc 2>/dev/null; echo @@; cat /proc/meminfo; echo @@; cat /proc/loadavg";

export function parseHostFacts(stdout: string) {
  const [uname, hostname, osRelease, uptime, cpus, meminfo, loadavg] = stdout.split(/^@@$/m).map((s) => s.trim());
  const os = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(osRelease ?? "")?.[1];
  const mem = (key: string) => {
    const kb = Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(meminfo ?? "")?.[1]);
    return Number.isFinite(kb) ? Math.round((kb * 1024) / 1e6) / 1000 : undefined;
  };
  const up = Number((uptime ?? "").split(/\s+/)[0]);
  const [l1, l5, l15] = (loadavg ?? "").split(/\s+/).map(Number);
  return {
    hostname: clean(hostname),
    os: clean(os),
    kernel: clean(uname),
    uptimeDays: Number.isFinite(up) ? Math.round((up / 86400) * 10) / 10 : undefined,
    cpus: Number(cpus) || undefined,
    memoryGb: { total: mem("MemTotal"), available: mem("MemAvailable") },
    load: Number.isFinite(l1) ? { "1m": l1, "5m": l5, "15m": l15 } : undefined,
  };
}

export async function hostFacts(t: SshTarget, ssh: SshRun = sshRun) {
  const res = await run(t, FACTS_COMMAND, ssh);
  if (!res.stdout.includes("@@")) throw new ServerError(`The check didn't run: ${clean(res.stderr) ?? "no output"}`);
  return { target: t.target, ...parseHostFacts(res.stdout), ...pinNote(t, res.hostKeySha256) };
}

// --- disk_usage ----------------------------------------------------------------------------------

const DISK_COMMAND = "df -P -k";
const PSEUDO_FS = /^(tmpfs|devtmpfs|overlay|squashfs|shm|udev|none|efivarfs|cgroup.*|proc|sysfs)$/;

export function parseDf(stdout: string) {
  const out = [];
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line.trim());
    if (!m || PSEUDO_FS.test(m[1]!) || m[6]!.startsWith("/snap/")) continue;
    const gb = (k: string) => Math.round((Number(k) * 1024) / 1e7) / 100;
    out.push({ filesystem: clean(m[1])!, mount: clean(m[6])!, sizeGb: gb(m[2]!), usedGb: gb(m[3]!), freeGb: gb(m[4]!), usedPercent: Number(m[5]) });
    if (out.length >= 100) break;
  }
  return out;
}

export async function diskUsage(t: SshTarget, ssh: SshRun = sshRun) {
  const res = await run(t, DISK_COMMAND, ssh);
  if (res.code !== 0 && !res.stdout.trim()) throw new ServerError(`df failed: ${clean(res.stderr) ?? ""}`);
  const filesystems = parseDf(res.stdout);
  return { target: t.target, filesystems, fullest: filesystems.reduce<(typeof filesystems)[number] | undefined>((a, f) => (!a || f.usedPercent > a.usedPercent ? f : a), undefined), ...pinNote(t, res.hostKeySha256) };
}

// --- service_status ------------------------------------------------------------------------------

const SERVICE_PROPS = "LoadState,ActiveState,SubState,UnitFileState,ActiveEnterTimestamp,Result,NRestarts,Description";

export function serviceCommand(service: string) {
  // Belt and braces: the argument schema already allows only these characters.
  if (!/^[A-Za-z0-9@._:-]{1,100}$/.test(service)) throw new ServerError("Invalid service name");
  return `systemctl show '${service}' --property=${SERVICE_PROPS} --no-pager`;
}

export function parseSystemctlShow(stdout: string) {
  const props: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) props[line.slice(0, i)] = clean(line.slice(i + 1)) ?? "";
  }
  return props;
}

export async function serviceStatus(t: SshTarget & { service: string }, ssh: SshRun = sshRun) {
  const res = await run(t, serviceCommand(t.service), ssh);
  const p = parseSystemctlShow(res.stdout);
  if (!p.LoadState) throw new ServerError(`systemctl didn't answer: ${clean(res.stderr) ?? "is this a systemd host?"}`);
  return {
    target: t.target,
    service: t.service,
    exists: p.LoadState !== "not-found",
    description: p.Description || undefined,
    active: p.ActiveState,
    sub: p.SubState,
    enabled: p.UnitFileState || undefined,
    since: p.ActiveEnterTimestamp || undefined,
    result: p.Result || undefined,
    restarts: p.NRestarts ? Number(p.NRestarts) : undefined,
    ...pinNote(t, res.hostKeySha256),
  };
}

// --- docker_ps -----------------------------------------------------------------------------------

export function parseDockerPs(stdout: string) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const c = JSON.parse(line) as Record<string, unknown>;
      out.push({ name: clean(c.Names), image: clean(c.Image), state: clean(c.State), status: clean(c.Status), created: clean(c.RunningFor), ports: clean(c.Ports) });
    } catch {
      // skip malformed lines
    }
    if (out.length >= 200) break;
  }
  return out;
}

export async function dockerPs(t: SshTarget & { all: boolean }, ssh: SshRun = sshRun) {
  const res = await run(t, `docker ps ${t.all ? "--all " : ""}--format '{{json .}}'`, ssh);
  if (res.code !== 0) {
    const err = clean(res.stderr) ?? "";
    if (/permission denied/i.test(err)) throw new ServerError(`${t.user} isn't allowed to use Docker on ${t.target} (add it to the docker group)`);
    if (/not found/i.test(err)) throw new ServerError(`Docker isn't installed on ${t.target}`);
    throw new ServerError(`docker ps failed: ${err}`);
  }
  const containers = parseDockerPs(res.stdout);
  return { target: t.target, containers, notRunning: containers.filter((c) => c.state !== "running").map((c) => c.name), ...pinNote(t, res.hostKeySha256) };
}
