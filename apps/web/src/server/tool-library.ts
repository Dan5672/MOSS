import "server-only";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { config } from "./config";
import { parseCustomTool } from "./custom-tools";

// The tools catalog: ready-made custom tool definitions. Bundled ones ship in library/tool-catalog; an
// optional remote catalog (a URL set on the Custom tools page) adds more. Definitions are data, not code,
// and each is validated again before it's shown or installed.

const entrySchema = z.object({
  file: z.string().regex(/^[a-z0-9_]+\.ya?ml$/).optional(),
  url: z.url().optional(),
  app: z.string().min(1).max(60),
  title: z.string().min(1).max(120),
  secret: z.string().max(400).optional(),
});
const indexSchema = z.object({ tools: z.array(entrySchema).max(500) });

export interface CatalogEntry {
  /** "bundled:<file>" or "remote:<url>". */
  ref: string;
  app: string;
  title: string;
  secret?: string;
  /** The definition, when it's at hand (bundled ones always are). */
  source?: string;
  key?: string;
  kind?: "read" | "write";
  description?: string;
  /** Why it can't be installed, if it can't. */
  problem?: string;
}

const MAX_BYTES = 100_000;

/** True for addresses that aren't on the public internet: loopback, private, link-local, CGNAT, ULA. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
}

/**
 * Fetches a small text file from the public internet over HTTPS. The web server sits inside your network, so
 * anything that resolves to a private or local address is refused, and redirects aren't followed.
 */
export async function fetchPublicText(raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That isn't a URL");
  }
  if (url.protocol !== "https:") throw new Error("Only https:// addresses can be fetched");
  if (url.username || url.password) throw new Error("Addresses with credentials in them aren't allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new Error(`Couldn't find ${host}`);
  if (addresses.some(isPrivateAddress)) throw new Error(`${host} is on a private or local network; only public addresses can be fetched`);
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json, application/yaml, text/plain" } });
  if (res.status >= 300 && res.status < 400) throw new Error("The address redirects elsewhere; give the final address");
  if (!res.ok) throw new Error(`The address answered HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error("That file is too large");
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("That file is too large");
  return text;
}

function describe(entry: Omit<CatalogEntry, "key" | "kind" | "description" | "problem">): CatalogEntry {
  if (!entry.source) return entry;
  try {
    const spec = parseCustomTool(entry.source);
    return { ...entry, key: spec.key, kind: spec.class, description: spec.description };
  } catch (err) {
    return { ...entry, problem: (err as Error).message };
  }
}

const libraryDir = () => join(config.libraryDir(), "tool-catalog");

/** The bundled catalog, each definition read and validated. */
export async function bundledCatalog(dir = libraryDir()): Promise<CatalogEntry[]> {
  const index = indexSchema.safeParse(parse(await readFile(join(dir, "index.yaml"), "utf8").catch(() => "tools: []")));
  if (!index.success) return [];
  return Promise.all(
    index.data.tools
      .filter((t) => t.file)
      .map(async (t) => describe({ ref: `bundled:${t.file}`, app: t.app, title: t.title, secret: t.secret, source: await readFile(join(dir, t.file!), "utf8").catch(() => undefined) })),
  );
}

/** A remote catalog's entries (each with the https URL of its definition). Definitions are fetched on install. */
export async function remoteCatalog(url: string): Promise<CatalogEntry[]> {
  const text = await fetchPublicText(url);
  let raw: unknown;
  try {
    raw = parse(text, { maxAliasCount: 0 });
  } catch {
    throw new Error("The catalog isn't valid YAML or JSON");
  }
  const index = indexSchema.safeParse(raw);
  if (!index.success) throw new Error('The catalog should look like { tools: [{ url, app, title, secret? }] }');
  return index.data.tools.filter((t) => t.url?.startsWith("https://")).map((t) => ({ ref: `remote:${t.url}`, app: t.app, title: t.title, secret: t.secret }));
}

/** A catalog entry's definition: read from the bundle, or fetched from the internet. */
export async function catalogSource(ref: string): Promise<string> {
  if (ref.startsWith("bundled:")) {
    const file = ref.slice("bundled:".length);
    const entry = (await bundledCatalog()).find((e) => e.ref === ref);
    if (!entry?.source || !/^[a-z0-9_]+\.ya?ml$/.test(file)) throw new Error("That tool isn't in the catalog");
    return entry.source;
  }
  if (ref.startsWith("remote:")) return fetchPublicText(ref.slice("remote:".length));
  throw new Error("Unknown catalog entry");
}
