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
  libraryDir: () => process.env.MOSS_LIBRARY_DIR ?? resolve(process.cwd(), "../../library"),
  /** Secure cookies need HTTPS. Behind a TLS proxy set MOSS_SECURE_COOKIES=true. */
  secureCookies: () => process.env.MOSS_SECURE_COOKIES === "true",
};
