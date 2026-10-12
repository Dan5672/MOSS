import "server-only";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { get } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isPrivateRange, parseRange } from "@moss/policy";
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

/** True for addresses that aren't on the public internet: the gate's own rule. */
export function isPrivateAddress(ip: string): boolean {
  const range = parseRange(ip);
  return !range || isPrivateRange(range);
}

/** A DNS lookup that always answers with the address already checked, so a second lookup can't move the request. */
export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_host, options, callback) => {
    if (options.all) (callback as (err: null, addresses: { address: string; family: number }[]) => void)(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/**
 * Fetches a small text file from the public internet over HTTPS. The web server sits inside your network, so
 * anything that resolves to a private or local address is refused, the connection goes to the address that was
 * checked (not a fresh lookup), and redirects aren't followed.
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
  return new Promise((resolve, reject) => {
    const req = get(url, { lookup: pinnedLookup(addresses[0]!), timeout: 10_000, headers: { Accept: "application/json, application/yaml, text/plain" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) return req.destroy(new Error("The address redirects elsewhere; give the final address"));
      if (status < 200 || status >= 300) return req.destroy(new Error(`The address answered HTTP ${status}`));
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) req.destroy(new Error("That file is too large"));
        else chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("timeout", () => req.destroy(new Error("The address took too long to answer")));
    req.on("error", reject);
  });
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

// Remote catalogs, kept an hour: the Custom tools page shows one on every visit.
const remoteCache = new Map<string, { at: number; entries: CatalogEntry[] }>();

/** A remote catalog's entries (each with the https URL of its definition). Definitions are fetched on install. */
export async function remoteCatalog(url: string, now = Date.now()): Promise<CatalogEntry[]> {
  const cached = remoteCache.get(url);
  if (cached && now - cached.at < 3_600_000) return cached.entries;
  const entries = await readRemoteCatalog(url);
  remoteCache.set(url, { at: now, entries });
  return entries;
}

async function readRemoteCatalog(url: string): Promise<CatalogEntry[]> {
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
