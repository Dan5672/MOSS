// MOSS's backup service: makes the same archives as deploy/backup.sh (so restore.sh restores either), when
// the web app asks ("Back up now") or the worker does (the schedule in Settings → Backups). It also lists,
// deletes and hands out archives, and only ever hands one out encrypted with a passphrase the person chose:
// an archive holds the master key.
//
// Only reachable inside Docker, and only with the backup token (which the web app and the worker hold).
// No dependencies: Node's standard library, plus pg_dump, psql, tar and openssl from the image.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, chown, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

const DIR = process.env.BACKUP_DIR ?? "/backups";
const SECRETS = process.env.MOSS_SECRETS_DIR ?? "/moss/secrets";
const ENV_FILE = process.env.MOSS_ENV_FILE ?? "/moss/env";
const CADDY_DATA = process.env.CADDY_DATA_DIR ?? "/caddy-data";
const TLS = process.env.TLS_DIR ?? "/tls";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const TOKEN = (await readFile(process.env.BACKUP_TOKEN_FILE ?? "/run/secrets/backup_token", "utf8")).trim();
const STATUS = join(DIR, ".status.json");
const NAME = /^moss-backup-\d{8}T\d{6}Z\.tar\.gz$/;
// openssl enc settings; restore.sh decrypts with the same.
const ENC = ["enc", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-salt"];

let running = null; // { startedAt, reason }

const log = (msg, extra = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed: ${err.trim().slice(-400) || `exit ${code}`}`))));
  });
}

const exists = (p) => stat(p).then(() => true, () => false);

async function owner() {
  // Archives belong to whoever owns the backups folder on the host, so backup.sh and restore.sh can use them.
  const s = await stat(DIR);
  return { uid: s.uid, gid: s.gid };
}

async function list() {
  const names = (await readdir(DIR).catch(() => [])).filter((n) => NAME.test(n)).sort().reverse();
  return Promise.all(
    names.map(async (name) => {
      const s = await stat(join(DIR, name));
      return { name, bytes: s.size, created: s.mtime.toISOString() };
    }),
  );
}

async function readStatus() {
  return JSON.parse(await readFile(STATUS, "utf8").catch(() => "null"));
}

async function backup(keep, reason) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const name = `moss-backup-${stamp}.tar.gz`;
  const work = join(DIR, `.work-${stamp}`);
  const { uid, gid } = await owner();
  await mkdir(work, { recursive: true, mode: 0o700 });
  try {
    await run("pg_dump", ["--dbname", DATABASE_URL, "--format=custom", "--no-owner", "--file", join(work, "db.dump")]);
    await run("pg_restore", ["--list", join(work, "db.dump")]); // unreadable dumps aren't kept
    await cp(SECRETS, join(work, "secrets"), { recursive: true });
    await cp(ENV_FILE, join(work, "env"));
    if (await exists(join(CADDY_DATA, "caddy/pki"))) await run("tar", ["-C", CADDY_DATA, "-cf", join(work, "https-pki.tar"), "caddy/pki"]);
    if (await exists(join(TLS, "web/tls.caddy"))) await run("tar", ["-C", TLS, "-cf", join(work, "https-tls.tar"), "--exclude", "web/admin.sock", "web"]);
    const migrations = (await run("psql", ["--dbname", DATABASE_URL, "-tAc", "select count(*) from drizzle.__drizzle_migrations"]).catch(() => "unknown")).trim();
    await writeFile(
      join(work, "manifest"),
      [
        `created=${stamp}`,
        `commit=${process.env.MOSS_COMMIT || "unknown"}`,
        `version=${process.env.MOSS_RELEASE || "unknown"}`,
        `migrations=${migrations}`,
        "compose_files=docker-compose.yml",
        `made_by=${reason}`,
        "",
      ].join("\n"),
    );
    const partial = join(DIR, `.${name}.partial`);
    await run("tar", ["-czf", partial, "-C", work, "."]);
    await chmod(partial, 0o600);
    await chown(partial, uid, gid).catch(() => {}); // not possible on every host (e.g. Docker Desktop); harmless
    await rename(partial, join(DIR, name));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  if (keep > 0) {
    for (const old of (await list()).slice(keep)) {
      await rm(join(DIR, old.name), { force: true });
      log("removed old backup", { name: old.name });
    }
  }
  return name;
}

function start(keep, reason) {
  running = { startedAt: new Date().toISOString(), reason };
  log("backup started", { reason });
  backup(keep, reason)
    .then(async (name) => {
      const s = await stat(join(DIR, name));
      await writeFile(STATUS, JSON.stringify({ ok: true, at: new Date().toISOString(), name, bytes: s.size, reason }));
      log("backup written", { name, bytes: s.size });
    })
    .catch(async (err) => {
      await writeFile(STATUS, JSON.stringify({ ok: false, at: new Date().toISOString(), error: String(err.message ?? err), reason })).catch(() => {});
      log("backup failed", { error: String(err.message ?? err) });
    })
    .finally(() => (running = null));
}

function authorised(req) {
  const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 10_000) throw new Error("too big");
  }
  return text ? JSON.parse(text) : {};
}

const send = (res, status, data) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));

createServer(async (req, res) => {
  try {
    if (req.url === "/health") return send(res, 200, { ok: true });
    if (!authorised(req)) return send(res, 401, { error: "unauthorised" });
    const url = new URL(req.url, "http://backup");
    const m = /^\/backups\/([^/]+)(\/download)?$/.exec(url.pathname);

    if (req.method === "GET" && url.pathname === "/backups") {
      return send(res, 200, { backups: await list(), running, last: await readStatus() });
    }
    if (req.method === "POST" && url.pathname === "/run") {
      const { keep = 10, reason = "manual" } = await body(req);
      if (running) return send(res, 409, { error: "A backup is already running." });
      start(Math.max(0, Math.min(1000, Number(keep) || 0)), reason === "scheduled" ? "scheduled" : "manual");
      return send(res, 202, { started: true });
    }
    if (m && !NAME.test(m[1])) return send(res, 404, { error: "no such backup" });
    if (m && req.method === "DELETE" && !m[2]) {
      await rm(join(DIR, m[1]), { force: true });
      return send(res, 200, { deleted: m[1] });
    }
    if (m && req.method === "POST" && m[2]) {
      const { passphrase } = await body(req);
      if (typeof passphrase !== "string" || passphrase.length < 12) return send(res, 400, { error: "The passphrase needs at least 12 characters." });
      const file = join(DIR, m[1]);
      if (!(await exists(file))) return send(res, 404, { error: "no such backup" });
      // The passphrase goes to openssl through its environment, never its command line.
      const enc = spawn("openssl", [...ENC, "-pass", "env:MOSS_BACKUP_PASSPHRASE"], {
        env: { PATH: process.env.PATH, MOSS_BACKUP_PASSPHRASE: passphrase },
        stdio: ["pipe", "pipe", "ignore"],
      });
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      createReadStream(file).pipe(enc.stdin);
      enc.stdout.pipe(res);
      enc.on("close", (code) => code !== 0 && res.destroy());
      log("backup downloaded (encrypted)", { name: m[1] });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    log("request failed", { error: String(err.message ?? err) });
    if (!res.headersSent) send(res, 500, { error: "The backup service hit an error." });
  }
}).listen(Number(process.env.PORT ?? 7090), () => log("backup service listening"));

// A backup that was cut short by a restart leaves its work folder behind.
for (const n of await readdir(DIR).catch(() => [])) {
  if (n.startsWith(".work-") || n.endsWith(".partial")) await rm(join(DIR, n), { recursive: true, force: true });
}
