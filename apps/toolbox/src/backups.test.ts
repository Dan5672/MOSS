import type { RenderedRequest } from "@moss/tools";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_SSH_FILE } from "./backups.js";
import type { RawRequest } from "./custom-http.js";
import { runTool } from "./runners.js";
import type { SshRun } from "./servers.js";

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
const sshArgs = { target: "10.0.0.5", source: "ssh_file", user: "moss", key: KEY };

function fakeSsh(stdout: string, code = 0, stderr = "") {
  const commands: string[] = [];
  const run: SshRun = async (_t, cmd) => (commands.push(cmd), { stdout, stderr, code, hostKeySha256: "SHA256:x" });
  return { run, commands };
}
const backup = (args: Record<string, unknown>, ssh?: SshRun, send?: RawRequest) => runTool("config_backup", args, undefined, undefined, undefined, send, ssh);

describe("config_backup", () => {
  it("copies a config file over SSH, base64 end to end, with its hash", async () => {
    const content = "server {\n  listen 80;\n}\n";
    const { run, commands } = fakeSsh(Buffer.from(content).toString("base64"));
    const res = await backup({ ...sshArgs, path: "/etc/nginx/nginx.conf" }, run);
    expect(commands).toEqual([`head -c ${MAX_SSH_FILE + 1} -- '/etc/nginx/nginx.conf' | base64 -w0`]);
    expect(res).toEqual({
      source: "ssh_file",
      target: "10.0.0.5",
      filename: "nginx.conf",
      contentType: "application/octet-stream",
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentBase64: Buffer.from(content).toString("base64"),
    });
  });

  it("only reads config locations, and refuses oversized or missing files", async () => {
    const { run } = fakeSsh("");
    for (const path of ["/root/.ssh/id_ed25519", "/etc/../root/x", "/etc/./shadow", "relative/file", "/etc/a b"]) {
      await expect(backup({ ...sshArgs, path }, run)).rejects.toThrow(/Invalid arguments/);
    }
    await expect(backup({ ...sshArgs, path: "/etc/big.conf" }, fakeSsh(Buffer.alloc(MAX_SSH_FILE + 1).toString("base64")).run)).rejects.toThrow(/larger than 512 KB/);
    await expect(backup({ ...sshArgs, path: "/etc/nope.conf" }, fakeSsh("", 1, "head: cannot open '/etc/nope.conf' for reading: No such file or directory").run)).rejects.toThrow(/doesn't exist/);
    await expect(backup({ target: "10.0.0.5", source: "ssh_file", user: "moss" }, run)).rejects.toThrow(/Invalid arguments/);
  });

  it("downloads a Pi-hole Teleporter zip and always ends the session", async () => {
    const zip = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.from("rest-of-zip")]);
    const seen: RenderedRequest[] = [];
    const send: RawRequest = async (r) => {
      seen.push(r);
      if (r.path === "/api/auth" && r.method === "POST") return { status: 200, body: Buffer.from(JSON.stringify({ session: { valid: true, sid: "S" } })), truncated: false };
      if (r.path === "/api/teleporter") return { status: 200, contentType: "application/zip", body: zip, truncated: false };
      return { status: 204, body: Buffer.alloc(0), truncated: false };
    };
    const res = (await backup({ target: "10.0.0.14", source: "pihole", password: "pw" }, undefined, send)) as { filename: string; bytes: number; contentBase64: string };
    expect(res).toMatchObject({ filename: "pihole-teleporter-10.0.0.14.zip", bytes: zip.length, contentBase64: zip.toString("base64") });
    expect(seen.find((r) => r.path === "/api/teleporter")!.headers["X-FTL-SID"]).toBe("S");
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/api/auth" });

    const notZip: RawRequest = async (r) => (r.path === "/api/teleporter" ? { status: 200, body: Buffer.from("<html>"), truncated: false } : send(r));
    await expect(backup({ target: "10.0.0.14", source: "pihole", password: "pw" }, undefined, notZip)).rejects.toThrow(/didn't return a zip/);
  });
});
