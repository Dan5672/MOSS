// HTTPS as the web app sees it: which mode is on, and MOSS's own certificate authority (public only), so
// Settings can offer it for download and show its fingerprint to compare on each device. The https service
// hands the certificate over on an address that only exists inside Docker.
import "server-only";
import { X509Certificate } from "node:crypto";

const CA_URL = process.env.MOSS_CA_URL ?? "http://https:8080/moss-ca.crt";

export async function httpsInfo() {
  const mode = process.env.MOSS_TLS || null;
  let ca: { fingerprint: string; expires: string } | null = null;
  if (mode === "internal") {
    try {
      const res = await fetch(CA_URL, { signal: AbortSignal.timeout(2000), cache: "no-store" });
      if (res.ok) {
        const cert = new X509Certificate(Buffer.from(await res.arrayBuffer()));
        ca = { fingerprint: cert.fingerprint256, expires: cert.validTo };
      }
    } catch {
      ca = null; // the https service isn't up yet, or hasn't made its CA
    }
  }
  return { mode, ca };
}
