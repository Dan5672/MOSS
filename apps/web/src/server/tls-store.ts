// Switching MOSS's HTTPS certificate from the web (Settings → HTTPS). The https service and the web app share
// /tls/web: the web app writes the uploaded certificate and key there, plus tls.caddy (which certificate
// Caddy uses), then asks Caddy to load its config again through the admin socket in the same folder. Only
// these two containers mount it. If Caddy refuses the new config, the previous files are put back.
import "server-only";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

// --- Let's Encrypt through a Cloudflare DNS challenge ---------------------------------------------
// Its own site block in sites/letsencrypt.caddy (imported by internal.Caddyfile), so the public name gets a trusted
// certificate while the LAN names and addresses keep MOSS's own. Caddy gets and renews the certificate itself, with
// the Cloudflare token read from a file beside it; nothing listens on the internet.
const SITES = join(DIR, "sites");
const LE_SITE = join(SITES, "letsencrypt.caddy");
const CF_TOKEN = join(DIR, "cloudflare-token");

/** The public name MOSS gets a Let's Encrypt certificate for, if it's set up. */
export async function letsEncryptHostname(): Promise<string | null> {
  const site = await readOrNull(LE_SITE);
  return site?.match(/^(\S+) \{/m)?.[1] ?? null;
}

/** Whether a Cloudflare token is stored for Let's Encrypt (never its value). */
export async function letsEncryptHasToken(): Promise<boolean> {
  return !!(await readOrNull(CF_TOKEN));
}

const site = (hostname: string) => `# Written by MOSS (Settings → HTTPS). Let's Encrypt for ${hostname}, through a Cloudflare DNS challenge.
${hostname} {
	tls {
		dns cloudflare {file.${CF_TOKEN}}
		resolvers 1.1.1.1
	}
	import moss
}
`;

/** Sets up Let's Encrypt for a hostname (a new token, or the stored one), or switches it off; puts the old files back if Caddy refuses. */
export async function setLetsEncrypt(next: { hostname: string; token?: string } | null): Promise<void> {
  const caddyfile = await readFile(CADDY_CONFIG, "utf8").catch(() => {
    throw new Error("This install's HTTPS can't be managed from MOSS (the https service's config isn't shared with the web app).");
  });
  if ((await readOrNull(CHOICE)) === null) throw new Error("HTTPS isn't running, so there's nothing to set up.");
  const before = { site: await readOrNull(LE_SITE), token: await readOrNull(CF_TOKEN) };
  if (next && !next.token && !before.token) throw new Error("Enter the Cloudflare API token.");
  try {
    if (next) {
      await mkdir(SITES, { recursive: true, mode: 0o755 });
      if (next.token) await writeAtomic(CF_TOKEN, next.token);
      await writeAtomic(LE_SITE, site(next.hostname));
    } else {
      await rm(LE_SITE, { force: true });
    }
    await reloadCaddy(caddyfile);
  } catch (err) {
    if (before.site !== null) await writeAtomic(LE_SITE, before.site);
    else await rm(LE_SITE, { force: true });
    if (before.token !== null) await writeAtomic(CF_TOKEN, before.token);
    else await rm(CF_TOKEN, { force: true });
    throw new Error(`The HTTPS service didn't accept it, so nothing changed. (${err instanceof Error ? err.message : String(err)})`);
  }
  // Switched off: the token isn't needed any more.
  if (!next) await rm(CF_TOKEN, { force: true });
}

// --- The names and addresses MOSS answers to on the network ---------------------------------------
// lan.caddy is the site block for them (it imports lan_site from internal.Caddyfile), and sni.caddy picks the
// certificate for browsers that connect by IP address. The https service writes both the first time it starts,
// from MOSS_HTTPS_HOSTS and MOSS_HTTPS_DEFAULT_NAME; after that they're changed here.
const LAN = join(DIR, "lan.caddy");
const SNI = join(DIR, "sni.caddy");
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Whether this is something MOSS can answer to: localhost, an IPv4 address or a host name. */
export function validHttpsHost(h: string): boolean {
  return /^[\d.]+$/.test(h) ? IPV4.test(h) : HOSTNAME.test(h);
}

const parseHosts = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

/** The names and addresses MOSS answers to over HTTPS. */
export async function httpsHosts(): Promise<string[]> {
  const site = await readOrNull(LAN);
  const line = site?.match(/^([^#\n{]+)\{/m)?.[1];
  return parseHosts(line ?? process.env.MOSS_HTTPS_HOSTS ?? "localhost");
}

/** Changes the names and addresses (already checked), putting the old files back if Caddy refuses. */
export async function setHttpsHosts(hosts: string[]): Promise<void> {
  const caddyfile = await readFile(CADDY_CONFIG, "utf8").catch(() => {
    throw new Error("This install's HTTPS can't be managed from MOSS (the https service's config isn't shared with the web app).");
  });
  if ((await readOrNull(CHOICE)) === null) throw new Error("HTTPS isn't running, so there's nothing to change.");
  const before = { lan: await readOrNull(LAN), sni: await readOrNull(SNI) };
  const sni = hosts.find((h) => IPV4.test(h)) ?? hosts.find((h) => h !== "localhost") ?? "localhost";
  try {
    await writeAtomic(LAN, `${hosts.join(", ")} {\n\timport lan_site\n}\n`);
    await writeAtomic(SNI, `default_sni ${sni}\n`);
    await reloadCaddy(caddyfile);
  } catch (err) {
    if (before.lan !== null) await writeAtomic(LAN, before.lan);
    else await rm(LAN, { force: true });
    if (before.sni !== null) await writeAtomic(SNI, before.sni);
    else await rm(SNI, { force: true });
    throw new Error(`The HTTPS service didn't accept it, so nothing changed. (${err instanceof Error ? err.message : String(err)})`);
  }
}
