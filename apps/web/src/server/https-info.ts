// HTTPS as the web app sees it: which mode is on, and MOSS's own certificate authority (public only), so
// Settings can offer it for download and show its fingerprint to compare on each device.
import "server-only";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CA_PATH = join(process.env.MOSS_CADDY_DATA ?? "/caddy", "caddy/pki/authorities/local/root.crt");

export async function httpsInfo() {
  const mode = process.env.MOSS_TLS || null;
  let ca: { fingerprint: string; expires: string } | null = null;
  if (mode === "internal") {
    try {
      const cert = new X509Certificate(await readFile(CA_PATH));
      ca = { fingerprint: cert.fingerprint256, expires: cert.validTo };
    } catch {
      ca = null; // not created yet: Caddy makes it on first start
    }
  }
  return { mode, ca };
}
