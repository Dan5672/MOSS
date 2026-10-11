#!/usr/bin/env node
// Makes MOSS business licence keys. Only whoever sells MOSS runs this: the private signing key lives outside the
// repository (by default in ~/.moss-licensing) and must never be committed. MOSS checks keys with the matching
// public key, built into packages/core/src/licensing/licence.ts (LICENCE_PUBLIC_KEYS).
//
//   node scripts/licence.mjs keygen [--kid moss-2026]          new signing key; prints the public key line to add
//   node scripts/licence.mjs issue --licensee "Acme Ltd" --expires 2027-10-31 [--features m365,slack] [--max-users 50]
//                                  [--kid moss-2026] [--id ...]
//   node scripts/licence.mjs show <key>                        what a key says (doesn't check the signature)
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const DIR = process.env.MOSS_LICENSING_DIR ?? join(homedir(), ".moss-licensing");
const [cmd, ...rest] = process.argv.slice(2);
const { values: a, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: { kid: { type: "string" }, licensee: { type: "string" }, expires: { type: "string" }, features: { type: "string" }, "max-users": { type: "string" }, id: { type: "string" } },
});

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function defaultKid() {
  const keys = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".key")) : [];
  if (keys.length === 1) return keys[0].slice(0, -4);
  die(keys.length ? `Several signing keys in ${DIR}: choose one with --kid.` : `No signing key in ${DIR}: run keygen first.`);
}

if (cmd === "keygen") {
  const kid = a.kid ?? `moss-${new Date().getFullYear()}`;
  if (!/^[a-z0-9-]{1,40}$/.test(kid)) die("--kid: lowercase letters, digits and hyphens.");
  const file = join(DIR, `${kid}.key`);
  if (existsSync(file)) die(`${file} exists already; choose another --kid.`);
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  writeFileSync(join(DIR, `${kid}.pub`), `${kid}:${pub}\n`);
  console.log(`Signing key written to ${file}. Back it up somewhere safe: without it, no new licences can be issued.`);
  console.log(`Add this to LICENCE_PUBLIC_KEYS in packages/core/src/licensing/licence.ts:\n  "${kid}": "${pub}",`);
} else if (cmd === "issue") {
  const kid = a.kid ?? defaultKid();
  const file = join(DIR, `${kid}.key`);
  if (!existsSync(file)) die(`No signing key ${file}.`);
  if (!a.licensee) die("--licensee is required.");
  if (!a.expires || Number.isNaN(Date.parse(a.expires))) die("--expires is required (a date, e.g. 2027-10-31).");
  const payload = {
    v: 1,
    kid,
    id: a.id ?? randomUUID(),
    licensee: a.licensee,
    plan: "business",
    features: a.features ? a.features.split(",").map((f) => f.trim()).filter(Boolean) : ["*"],
    ...(a["max-users"] ? { maxUsers: Number(a["max-users"]) } : {}),
    issued: new Date().toISOString(),
    expires: new Date(`${a.expires}${a.expires.length === 10 ? "T23:59:59Z" : ""}`).toISOString(),
  };
  const body = `MOSS1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const key = createPrivateKey(readFileSync(file, "utf8"));
  // Check it against its own public key before handing it out.
  createPublicKey(key);
  console.log(`${body}.${sign(null, Buffer.from(body), key).toString("base64url")}`);
} else if (cmd === "show") {
  const parts = (positionals[0] ?? "").split(".");
  if (parts.length !== 3) die("Usage: show <key>");
  console.log(JSON.stringify(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")), null, 2));
} else {
  die("Usage: node scripts/licence.mjs keygen | issue | show (see the top of this file).");
}
