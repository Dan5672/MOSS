import { createHash, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTool } from "./runners.js";
import { parseDf, parseDockerPs, parseHostFacts, parseSystemctlShow, serviceCommand, type SshRun } from "./servers.js";

const HOST = utils.generateKeyPairSync("ed25519");
const CLIENT = utils.generateKeyPairSync("ed25519");
const STRANGER = utils.generateKeyPairSync("ed25519");

describe("server checks over a real SSH connection", () => {
  let server: Server;
  let port: number;
  const commands: string[] = [];
  let hostFp = "";

  beforeAll(async () => {
    const allowed = utils.parseKey(CLIENT.public);
    if (allowed instanceof Error) throw allowed;
    const hostKey = utils.parseKey(HOST.public);
    if (hostKey instanceof Error) throw hostKey;
    hostFp = `SHA256:${createHash("sha256").update(hostKey.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
    server = new Server({ hostKeys: [HOST.private] }, (client) => {
      client
        .on("authentication", (ctx) => {
          if (ctx.method === "publickey" && ctx.key.algo === allowed.type && timingSafeEqual(ctx.key.data, allowed.getPublicSSH())) {
            if (!ctx.signature) return ctx.accept();
            return allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
          }
          ctx.reject(["publickey"]);
        })
        .on("ready", () => {
          client.on("session", (accept) => {
            accept().once("exec", (acc, _rej, info) => {
              commands.push(info.command);
              const stream = acc();
              if (info.command.startsWith("df")) stream.write("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 91000000 9000000 91% /\ntmpfs 1000 0 1000 0% /run\n");
              stream.exit(0);
              stream.end();
            });
          });
        })
        .on("error", () => {});
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  const args = (over: Record<string, unknown> = {}) => ({ target: "127.0.0.1", user: "moss", key: CLIENT.private, port, timeoutMs: 5000, ...over });

  it("logs in with the key, runs the fixed command, and reports the host key fingerprint", async () => {
    const res = (await runTool("disk_usage", args())) as { filesystems: unknown[]; fullest: { mount: string; usedPercent: number }; hostKeySha256: string; note?: string };
    expect(commands.at(-1)).toBe("df -P -k");
    expect(res.filesystems).toHaveLength(1);
    expect(res.fullest).toMatchObject({ mount: "/", usedPercent: 91 });
    expect(res.hostKeySha256).toBe(hostFp);
    expect(res.note).toMatch(/not pinned/);
  });

  it("checks a pinned host key, refusing a different server", async () => {
    const pinned = (await runTool("disk_usage", args({ hostKeySha256: hostFp }))) as { note?: string };
    expect(pinned.note).toBeUndefined();
    const other = `SHA256:${"A".repeat(43)}`;
    await expect(runTool("disk_usage", args({ hostKeySha256: other }))).rejects.toThrow(/Host key mismatch.*Refusing to log in/);
  });

  it("reports a refused key, and refuses passwords outright", async () => {
    await expect(runTool("disk_usage", args({ key: STRANGER.private }))).rejects.toThrow(/refused the key/);
    await expect(runTool("disk_usage", args({ key: "hunter2" }))).rejects.toThrow(/isn't an SSH private key/);
  });

  it("keeps service names out of the shell", async () => {
    expect(serviceCommand("nginx.service")).toBe("systemctl show 'nginx.service' --property=LoadState,ActiveState,SubState,UnitFileState,ActiveEnterTimestamp,Result,NRestarts,Description --no-pager");
    expect(() => serviceCommand("x'; reboot; '")).toThrow(/Invalid service name/);
    await expect(runTool("service_status", args({ service: "a;reboot" }))).rejects.toThrow(/Invalid arguments/);
  });
});

describe("server check parsers", () => {
  const fake = (stdout: string, code = 0, stderr = ""): SshRun => async () => ({ stdout, stderr, code, hostKeySha256: "SHA256:x" });
  const t = { target: "10.0.0.5", user: "moss", key: "-----BEGIN OPENSSH PRIVATE KEY-----\n...", port: 22, timeoutMs: 5000 };

  it("parses host facts", () => {
    const out = [
      "Linux 6.1.0-18-amd64 x86_64",
      "nas",
      'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian',
      "864000.12 1000.00",
      "4",
      "MemTotal:       16303340 kB\nMemAvailable:    9000000 kB",
      "0.52 0.48 0.40 1/500 1234",
    ].join("\n@@\n");
    expect(parseHostFacts(out)).toEqual({
      hostname: "nas",
      os: "Debian GNU/Linux 12 (bookworm)",
      kernel: "Linux 6.1.0-18-amd64 x86_64",
      uptimeDays: 10,
      cpus: 4,
      memoryGb: { total: 16.695, available: 9.216 },
      load: { "1m": 0.52, "5m": 0.48, "15m": 0.4 },
    });
  });

  it("parses df, skipping pseudo filesystems and snaps", () => {
    const out = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/nvme0n1p2 488245288 200000000 263000000 44% /\noverlay 1 1 0 100% /var/lib/docker/x\n/dev/loop3 56832 56832 0 100% /snap/core/1\n//nas/share 1000000000 900000000 100000000 90% /mnt/nas share\n";
    expect(parseDf(out).map((f) => [f.mount, f.usedPercent])).toEqual([
      ["/", 44],
      ["/mnt/nas share", 90],
    ]);
  });

  it("parses systemctl and docker output, and explains common failures", async () => {
    expect(parseSystemctlShow("LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\n")).toMatchObject({ ActiveState: "failed", Result: "exit-code" });
    const docker = '{"Names":"plex","Image":"plexinc/pms","State":"running","Status":"Up 3 days"}\n{"Names":"old","Image":"x","State":"exited","Status":"Exited (1) 2 days ago"}\nnot json';
    expect(parseDockerPs(docker)).toHaveLength(2);
    const res = (await runTool("docker_ps", { ...t }, undefined, undefined, undefined, undefined, fake(docker))) as { notRunning: string[] };
    expect(res.notRunning).toEqual(["old"]);
    await expect(runTool("docker_ps", { ...t }, undefined, undefined, undefined, undefined, fake("", 1, "permission denied while trying to connect to the Docker daemon socket"))).rejects.toThrow(
      /isn't allowed to use Docker/,
    );
    const svc = (await runTool("service_status", { ...t, service: "nginx" }, undefined, undefined, undefined, undefined, fake("LoadState=not-found\nActiveState=inactive\n"))) as { exists: boolean };
    expect(svc.exists).toBe(false);
  });
});
