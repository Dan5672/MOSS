// node --test deploy/backup/moss-backup.test.mjs
// The worker's run token may start a backup and nothing else; the web app's token opens every route.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const PORT = 17090 + Math.floor(Math.random() * 1000);
let proc;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "moss-backup-"));
  await writeFile(join(dir, "full"), "full-token\n");
  await writeFile(join(dir, "run"), "run-token\n");
  proc = spawn(process.execPath, [new URL("./moss-backup.mjs", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")], {
    env: { ...process.env, PORT: String(PORT), BACKUP_DIR: dir, BACKUP_TOKEN_FILE: join(dir, "full"), BACKUP_RUN_TOKEN_FILE: join(dir, "run") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => proc.stdout.on("data", (d) => String(d).includes("listening") && resolve()));
});
after(() => proc.kill());

const call = (path, token, method = "GET", body) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });

test("run token starts a backup", async () => {
  assert.equal((await call("/run", "run-token", "POST", { reason: "scheduled" })).status, 202);
});

test("run token cannot list, delete or download", async () => {
  assert.equal((await call("/backups", "run-token")).status, 401);
  assert.equal((await call("/backups/moss-backup-20260101T000000Z.tar.gz", "run-token", "DELETE")).status, 401);
  assert.equal((await call("/backups/moss-backup-20260101T000000Z.tar.gz/download", "run-token", "POST", { passphrase: "a-long-passphrase" })).status, 401);
});

test("full token lists; a wrong token gets nothing", async () => {
  assert.equal((await call("/backups", "full-token")).status, 200);
  assert.equal((await call("/backups", "nope")).status, 401);
  assert.equal((await call("/backups", "")).status, 401);
});

test("with downloads turned off, even the full token can't take an archive out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moss-backup-off-"));
  await writeFile(join(dir, "full"), "full-token\n");
  await writeFile(join(dir, "moss-backup-20260101T000000Z.tar.gz"), "not really an archive");
  const port = PORT + 1;
  const off = spawn(process.execPath, [new URL("./moss-backup.mjs", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")], {
    env: { ...process.env, PORT: String(port), BACKUP_DIR: dir, BACKUP_TOKEN_FILE: join(dir, "full"), MOSS_BACKUP_DOWNLOADS: "false" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise((resolve) => off.stdout.on("data", (d) => String(d).includes("listening") && resolve()));
    const res = await fetch(`http://127.0.0.1:${port}/backups/moss-backup-20260101T000000Z.tar.gz/download`, {
      method: "POST",
      headers: { authorization: "Bearer full-token" },
      body: JSON.stringify({ passphrase: "a-long-passphrase" }),
    });
    assert.equal(res.status, 403);
  } finally {
    off.kill();
  }
});
