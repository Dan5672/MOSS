// config_backup: copies a device's configuration for the gate to encrypt and store. The file travels back
// to the gate base64-encoded; the gate removes it from the result before anything is logged or shown.
import { BACKUP_PATH, type ConfigBackupFile } from "@moss/tools";
import { createHash } from "node:crypto";
import { sendRequest, type RawRequest } from "./custom-http.js";
import { call, HomelabError, obj } from "./homelab.js";
import { clean } from "./parsers.js";
import { run, ServerError, sshRun, type SshRun } from "./servers.js";

/** SSH output is capped at 1 MB, so files are limited to what fits once base64-encoded. */
export const MAX_SSH_FILE = 512 * 1024;
const MAX_PIHOLE_EXPORT = 20 * 1024 * 1024;

export interface BackupArgs {
  target: string;
  source: "ssh_file" | "pihole";
  user?: string;
  key?: string;
  path?: string;
  hostKeySha256?: string;
  password?: string;
  scheme?: "http" | "https";
  verifyTls: boolean;
  port?: number;
  timeoutMs: number;
}

const finish = (a: BackupArgs, filename: string, contentType: string, content: Buffer): ConfigBackupFile => ({
  source: a.source,
  target: a.target,
  filename,
  contentType,
  bytes: content.length,
  sha256: createHash("sha256").update(content).digest("hex"),
  contentBase64: content.toString("base64"),
});

export async function configBackup(a: BackupArgs, ssh: SshRun = sshRun, send: RawRequest = sendRequest): Promise<ConfigBackupFile> {
  if (a.source === "ssh_file") {
    const path = a.path ?? "";
    // The argument schema already enforces this; checked again because the path reaches a shell.
    if (!BACKUP_PATH.test(path) || path.split("/").some((s) => s === ".." || s === ".")) throw new ServerError("Invalid backup path");
    const t = { target: a.target, user: a.user!, key: a.key!, port: a.port ?? 22, hostKeySha256: a.hostKeySha256, timeoutMs: a.timeoutMs };
    // Read one byte past the limit so an oversized file is detected, not silently cut.
    const res = await run(t, `head -c ${MAX_SSH_FILE + 1} -- '${path}' | base64 -w0`, ssh);
    if (res.code !== 0) {
      const err = clean(res.stderr) ?? "";
      if (/No such file/i.test(err)) throw new ServerError(`${path} doesn't exist on ${a.target}`);
      if (/Permission denied/i.test(err)) throw new ServerError(`${a.user} can't read ${path} on ${a.target}`);
      throw new ServerError(`Couldn't read ${path}: ${err || `exit ${res.code}`}`);
    }
    const content = Buffer.from(res.stdout.trim(), "base64");
    if (content.length > MAX_SSH_FILE) throw new ServerError(`${path} is larger than ${MAX_SSH_FILE / 1024} KB`);
    if (content.length === 0) throw new ServerError(`${path} is empty`);
    return finish(a, path.split("/").pop()!, "application/octet-stream", content);
  }

  // Pi-hole v6 Teleporter: a zip of its settings, lists and local DNS records.
  const base = { target: a.target, port: a.port ?? 80, scheme: a.scheme ?? "http", verifyTls: a.verifyTls, timeoutMs: a.timeoutMs };
  const auth = await call(send, "Pi-hole", base, "POST", "/api/auth", { "Content-Type": "application/json" }, JSON.stringify({ password: a.password }));
  const session = obj(obj(auth.json).session);
  const sid = clean(session.sid);
  if (session.valid !== true || !sid) throw new HomelabError("Pi-hole refused the password (Pi-hole v6 is required)");
  try {
    const res = await send(
      { ...base, method: "GET", path: "/api/teleporter", headers: { "X-FTL-SID": sid, Accept: "application/zip" }, maxItems: 1 },
      MAX_PIHOLE_EXPORT,
    );
    if (res.status !== 200) throw new HomelabError(`Pi-hole's Teleporter answered HTTP ${res.status}`);
    if (res.truncated) throw new HomelabError("The Pi-hole export is larger than 20 MB");
    // A zip file starts with "PK".
    if (res.body.subarray(0, 2).toString("latin1") !== "PK") throw new HomelabError("Pi-hole's Teleporter didn't return a zip file");
    return finish(a, `pihole-teleporter-${a.target}.zip`, "application/zip", res.body);
  } finally {
    await call(send, "Pi-hole", base, "DELETE", "/api/auth", { "X-FTL-SID": sid }).catch(() => {});
  }
}
