// Switching MOSS's HTTPS certificate from the web (Settings → HTTPS). The https service and the web app share
// /tls/web: the web app writes the uploaded certificate and key there, plus tls.caddy (which certificate
// Caddy uses), then asks Caddy to load its config again through the admin socket in the same folder. Only
// these two containers mount it. If Caddy refuses the new config, the previous files are put back.
import "server-only";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";

const DIR = process.env.MOSS_TLS_DIR ?? "/tls/web";
const CADDY_CONFIG = process.env.MOSS_CADDY_CONFIG ?? "/caddy/internal.Caddyfile";
const SOCKET = process.env.MOSS_CADDY_ADMIN ?? join(DIR, "admin.sock");
const CERT = join(DIR, "uploaded-cert.pem");
const KEY = join(DIR, "uploaded-key.pem");
const CHOICE = join(DIR, "tls.caddy");

export const OWN_CA = "tls internal\n";
const UPLOADED = `tls ${CERT} ${KEY}\n`;

/** Which certificate Caddy is set to use, or null if the shared folder isn't there (HTTPS off, or not managed here). */
export async function activeCertificate(): Promise<"own_ca" | "uploaded" | null> {
  try {
    return (await readFile(CHOICE, "utf8")).trim().startsWith("tls internal") ? "own_ca" : "uploaded";
  } catch {
    return null;
  }
}

/** Asks Caddy to load its config again (it re-reads tls.caddy and the certificate files). */
function reloadCaddy(caddyfile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: SOCKET, path: "/load", method: "POST", headers: { "Content-Type": "text/caddyfile", Host: "localhost" }, timeout: 15_000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error(body.slice(0, 300) || `HTTP ${res.statusCode}`))));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Caddy didn't answer")));
    req.on("error", reject);
    req.end(caddyfile);
  });
}

async function readOrNull(path: string) {
  return readFile(path, "utf8").catch(() => null);
}

async function writeAtomic(path: string, text: string) {
  // Readable by the https service, which runs as a different user; nothing else mounts this folder.
  await writeFile(`${path}.new`, text, { mode: 0o644 });
  await rename(`${path}.new`, path);
}

/** Switches to an uploaded certificate (already checked) or back to MOSS's own CA, restoring the old files if Caddy refuses. */
export async function switchCertificate(next: { certPem: string; keyPem: string } | "own_ca"): Promise<void> {
  const caddyfile = await readFile(CADDY_CONFIG, "utf8").catch(() => {
    throw new Error("This install's HTTPS can't be managed from MOSS (the https service's config isn't shared with the web app).");
  });
  const before = { cert: await readOrNull(CERT), key: await readOrNull(KEY), choice: await readOrNull(CHOICE) };
  if (before.choice === null) throw new Error("HTTPS isn't running, so there's nothing to switch.");
  try {
    if (next === "own_ca") {
      await writeAtomic(CHOICE, OWN_CA);
    } else {
      await writeAtomic(CERT, next.certPem);
      await writeAtomic(KEY, next.keyPem);
      await writeAtomic(CHOICE, UPLOADED);
    }
    await reloadCaddy(caddyfile);
  } catch (err) {
    await writeAtomic(CHOICE, before.choice);
    if (before.cert !== null) await writeAtomic(CERT, before.cert);
    if (before.key !== null) await writeAtomic(KEY, before.key);
    throw new Error(`The HTTPS service didn't accept it, so nothing changed. (${err instanceof Error ? err.message : String(err)})`);
  }
  if (next === "own_ca") {
    // The uploaded key isn't needed any more.
    await rm(KEY, { force: true });
    await rm(CERT, { force: true });
  }
}
