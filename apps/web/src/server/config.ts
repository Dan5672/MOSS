import "server-only";
import { parseMasterKey } from "@moss/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function secretFromEnv(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  return file ? readFileSync(file, "utf8").trim() : process.env[name];
}

export const config = {
  gateUrl: () => process.env.GATE_URL ?? "http://gate:7080",
  /** Token for the gate's write-only secrets API. */
  webToken: () => {
    const t = secretFromEnv("WEB_TOKEN");
    if (!t) throw new Error("Set WEB_TOKEN or WEB_TOKEN_FILE");
    return t;
  },
  /**
   * Key for encrypting users' TOTP secrets. Separate from the secrets-broker master key,
   * which only the gate holds.
   */
  appKey: (() => {
    let cached: Buffer | undefined;
    return () => {
      if (cached) return cached;
      const raw = secretFromEnv("MOSS_APP_KEY");
      if (!raw) throw new Error("Set MOSS_APP_KEY or MOSS_APP_KEY_FILE");
      cached = parseMasterKey(Buffer.from(raw));
      return cached;
    };
  })(),
  /** The backup service (MOSS backups), and its token. Absent on installs without it. */
  backupUrl: () => process.env.BACKUP_URL ?? null,
  backupToken: () => secretFromEnv("BACKUP_TOKEN") ?? "",
  /** The one-time code deploy/init.sh made (install.sh prints a link with it), needed to set MOSS up (unset: no code, e.g. development). */
  setupCode: () => secretFromEnv("MOSS_SETUP_CODE") ?? null,
  libraryDir: () => process.env.MOSS_LIBRARY_DIR ?? resolve(process.cwd(), "../../library"),
  /** Always mark the session cookie Secure (it already is for any sign-in over HTTPS). */
  secureCookies: () => process.env.MOSS_SECURE_COOKIES === "true",
  /** MOSS_BACKUP_DOWNLOADS=false: backups stay on the host (docs/hardening.md). */
  backupDownloads: () => process.env.MOSS_BACKUP_DOWNLOADS !== "false",
  /** MOSS_PUBLIC_URL: the addresses people open MOSS at, comma-separated; empty means taken from each request. */
  publicUrls: () =>
    (process.env.MOSS_PUBLIC_URL ?? "")
      .split(",")
      .map((u) => u.trim().replace(/\/+$/, ""))
      .filter(Boolean),
};
