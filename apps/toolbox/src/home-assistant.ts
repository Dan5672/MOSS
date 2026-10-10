// Home Assistant: health, error log, device registry, and the two system calls MOSS makes for the Home
// Assistant module (notifications and its own sensor.moss_* states). Requests go to the literal target IP.
// Everything Home Assistant returns is data from the device: it is cleaned and summarised here.
import type { HomeAssistantDevice, HomeAssistantDevices, HomeAssistantHealth, HomeAssistantLogGroup, HomeAssistantLogs } from "@moss/tools";
import { sendRequest, type RawRequest } from "./custom-http.js";
import { arr, call, HomelabError, obj, type Base } from "./homelab.js";
import { clean } from "./parsers.js";

type Ha = Base & { token: string };

const PRODUCT = "Home Assistant";
const auth = (a: Ha) => ({ Authorization: `Bearer ${a.token}` });

/** Integration (config entry) states that mean it isn't working. */
const FAILED_ENTRY_STATES = new Set(["setup_error", "setup_retry", "migration_error", "failed_unload"]);

export async function homeassistantHealth(a: Ha, send: RawRequest = sendRequest): Promise<HomeAssistantHealth> {
  const [config, states, entries] = await Promise.all([
    call(send, PRODUCT, a, "GET", "/api/config", auth(a)),
    call(send, PRODUCT, a, "GET", "/api/states", auth(a)),
    // Needs an administrator's token; without one the integration list is simply unknown.
    call(send, PRODUCT, a, "GET", "/api/config/config_entries/entry", auth(a)).catch(() => null),
  ]);
  const c = obj(config.json);
  const all = arr(states.json).filter((s) => typeof s.entity_id === "string");
  const unavailable = all.filter((s) => s.state === "unavailable");
  const updates = all.filter((s) => (s.entity_id as string).startsWith("update.") && s.state === "on");
  const entryList = entries ? arr(entries.json) : null;
  return {
    version: clean(c.version),
    locationName: clean(c.location_name),
    entities: all.length,
    unavailable: {
      count: unavailable.length,
      entities: unavailable.slice(0, 30).map((s) => ({ entity: clean(s.entity_id)!, name: clean(obj(s.attributes).friendly_name) })),
    },
    updates: updates.slice(0, 50).map((s) => {
      const attrs = obj(s.attributes);
      return { entity: clean(s.entity_id)!, name: clean(attrs.title) ?? clean(attrs.friendly_name), installed: clean(attrs.installed_version), latest: clean(attrs.latest_version) };
    }),
    integrations: entryList
      ? {
          total: entryList.length,
          failed: entryList
            .filter((e) => FAILED_ENTRY_STATES.has(String(e.state)))
            .slice(0, 50)
            .map((e) => ({ domain: clean(e.domain), title: clean(e.title), state: String(e.state), reason: clean(e.reason) })),
        }
      : null,
  };
}

// --- Error log -----------------------------------------------------------------------------------

/** How much of the end of the log is read. */
const LOG_TAIL_BYTES = 768 * 1024;
const LINE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})(?:\.\d+)?\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+\(([^)]*)\)\s+\[([^\]]+)\]\s?(.*)$/;
const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

interface LogEntry {
  at: string;
  time: number;
  level: string;
  logger: string;
  message: string;
  tail?: string;
}

/** Numbers, addresses and ids vary between repeats of the same problem; group without them. */
function fingerprint(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "#")
    .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, "#")
    .replace(/\b[0-9a-f]{12,}\b/gi, "#")
    .replace(/\b0x[0-9a-f]+\b/gi, "#")
    .replace(/\d+(?:\.\d+)*/g, "#")
    .slice(0, 160);
}

export function parseHomeAssistantLog(text: string, opts: { sinceHours: number; minLevel: string; partial: boolean }): HomeAssistantLogs {
  const entries: LogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) {
      entries.push({ at: m[1]!.replace(" ", "T"), time: Date.parse(m[1]!.replace(" ", "T") + "Z"), level: m[2]!, logger: m[4]!, message: m[5]! });
    } else if (entries.length && line.trim()) {
      // A traceback or other continuation: keep its last line, which usually names the exception.
      entries[entries.length - 1]!.tail = line.trim();
    }
  }
  // Home Assistant writes local time without a zone, so "the last N hours" is measured back from the newest entry.
  const newest = entries.reduce((n, e) => (Number.isFinite(e.time) && e.time > n ? e.time : n), 0);
  const cutoff = newest - opts.sinceHours * 3_600_000;
  const minRank = LEVELS.indexOf(opts.minLevel);
  const kept = entries
    .filter((e) => e.time >= cutoff && LEVELS.indexOf(e.level) >= minRank)
    .map((e) => (e.tail ? { ...e, message: `${e.message} | ${e.tail}` } : e));

  const counts: Record<string, number> = {};
  const groups = new Map<string, HomeAssistantLogGroup>();
  for (const e of kept) {
    counts[e.level] = (counts[e.level] ?? 0) + 1;
    const key = `${e.level}|${e.logger}|${fingerprint(e.message)}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.lastSeen = e.at;
    } else {
      groups.set(key, { level: e.level, logger: clean(e.logger)!, count: 1, firstSeen: e.at, lastSeen: e.at, message: clean(e.message)!.slice(0, 300) });
    }
  }
  const rank = (g: HomeAssistantLogGroup) => LEVELS.indexOf(g.level);
  return {
    from: kept[0]?.at,
    to: kept.at(-1)?.at,
    partial: opts.partial,
    counts,
    groups: [...groups.values()].sort((x, y) => rank(y) - rank(x) || y.count - x.count).slice(0, 40),
    latest: kept
      .filter((e) => LEVELS.indexOf(e.level) >= LEVELS.indexOf("ERROR"))
      .slice(-15)
      .map((e) => ({ at: e.at, level: e.level, logger: clean(e.logger)!, message: clean(e.message)!.slice(0, 300) })),
  };
}

export async function homeassistantLogs(a: Ha & { sinceHours: number; minLevel: string }, send: RawRequest = sendRequest): Promise<HomeAssistantLogs> {
  let res;
  try {
    res = await send(
      {
        target: a.target,
        port: a.port,
        scheme: a.scheme ?? "http",
        method: "GET",
        path: "/api/error_log",
        // Only the end of the log matters; Home Assistant serves the file with range support.
        headers: { ...auth(a), Range: `bytes=-${LOG_TAIL_BYTES}` },
        verifyTls: a.verifyTls,
        timeoutMs: a.timeoutMs,
        maxItems: 1,
      },
      LOG_TAIL_BYTES + 1024,
    );
  } catch (err) {
    throw new HomelabError(`Could not reach ${PRODUCT} at ${a.target}:${a.port}: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new HomelabError(`${PRODUCT} rejected the credentials (HTTP ${res.status}); reading the log needs an administrator's token`);
  if (res.status === 404) throw new HomelabError(`${PRODUCT} has no error log to read (HTTP 404)`);
  if (res.status >= 400) throw new HomelabError(`${PRODUCT} answered HTTP ${res.status}`);
  let text = res.body.toString("utf8");
  const partial = res.status === 206 || res.truncated;
  // A range starts mid-line; drop the cut-off first line.
  if (res.status === 206) text = text.slice(text.indexOf("\n") + 1);
  return parseHomeAssistantLog(text, { sinceHours: a.sinceHours, minLevel: a.minLevel, partial });
}

// --- Devices -------------------------------------------------------------------------------------

/**
 * Rendered by Home Assistant's template API (read-only): every device that has at least one entity,
 * with its registry details and any IP address its entities report (device trackers, network integrations).
 */
const DEVICES_TEMPLATE = `
{%- set ns = namespace(out=[]) -%}
{%- for d in states | map(attribute='entity_id') | map('device_id') | reject('none') | unique | list -%}
{%- set ips = namespace(v=[]) -%}
{%- for e in device_entities(d) -%}
{%- set ip = state_attr(e, 'ip') or state_attr(e, 'ip_address') or state_attr(e, 'host') -%}
{%- if ip -%}{%- set ips.v = ips.v + [ip | string] -%}{%- endif -%}
{%- endfor -%}
{%- set ns.out = ns.out + [{
  'id': d,
  'name': device_attr(d, 'name_by_user') or device_attr(d, 'name'),
  'manufacturer': device_attr(d, 'manufacturer'),
  'model': device_attr(d, 'model'),
  'area': area_name(d),
  'connections': (device_attr(d, 'connections') or []) | list | map('list') | list,
  'ips': ips.v | unique | list
}] -%}
{%- endfor -%}
{{ ns.out | tojson }}`;

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function parseDevices(json: unknown, limit: number): HomeAssistantDevices {
  const devices: HomeAssistantDevice[] = arr(json).flatMap((d) => {
    const id = clean(d.id);
    if (!id) return [];
    const connections = Array.isArray(d.connections) ? d.connections : [];
    const macs = connections
      .filter((c): c is unknown[] => Array.isArray(c) && c[0] === "mac")
      .map((c) => String(c[1]).toLowerCase().replace(/-/g, ":"))
      .filter((m) => MAC.test(m));
    const ips = (Array.isArray(d.ips) ? d.ips : []).map((ip) => String(ip).trim()).filter((ip) => IPV4.test(ip));
    return [{ id, name: clean(d.name), manufacturer: clean(d.manufacturer), model: clean(d.model), area: clean(d.area), macs: [...new Set(macs)], ips: [...new Set(ips)] }];
  });
  return { total: devices.length, devices: devices.slice(0, limit) };
}

export async function homeassistantDevices(a: Ha & { limit: number }, send: RawRequest = sendRequest): Promise<HomeAssistantDevices> {
  let res;
  try {
    res = await send({
      target: a.target,
      port: a.port,
      scheme: a.scheme ?? "http",
      method: "POST",
      path: "/api/template",
      headers: { ...auth(a), "Content-Type": "application/json" },
      body: JSON.stringify({ template: DEVICES_TEMPLATE }),
      verifyTls: a.verifyTls,
      timeoutMs: a.timeoutMs,
      maxItems: 1,
    });
  } catch (err) {
    throw new HomelabError(`Could not reach ${PRODUCT} at ${a.target}:${a.port}: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new HomelabError(`${PRODUCT} rejected the credentials (HTTP ${res.status})`);
  if (res.status >= 400) throw new HomelabError(`${PRODUCT} couldn't list its devices (HTTP ${res.status}): ${clean(res.body.toString("utf8"))?.slice(0, 200) ?? ""}`);
  if (res.truncated) throw new HomelabError(`${PRODUCT}'s device list was too large`);
  let json: unknown;
  try {
    json = JSON.parse(res.body.toString("utf8"));
  } catch {
    throw new HomelabError(`${PRODUCT} answered the device list with something that isn't JSON`);
  }
  return parseDevices(json, a.limit);
}

// --- System calls (MOSS itself, for the Home Assistant module) ----------------------------------

export async function homeassistantNotify(a: Ha & { service: string; title: string; message: string; url?: string }, send: RawRequest = sendRequest) {
  const body = { title: a.title, message: a.message, ...(a.url ? { data: { url: a.url, clickAction: a.url } } : {}) };
  await call(send, PRODUCT, a, "POST", `/api/services/notify/${a.service}`, { ...auth(a), "Content-Type": "application/json" }, JSON.stringify(body));
  return { service: a.service, sent: true };
}

export async function homeassistantPublish(
  a: Ha & { states: { entity: string; state: string; attributes: Record<string, string | number | boolean> }[] },
  send: RawRequest = sendRequest,
) {
  for (const s of a.states) {
    await call(send, PRODUCT, a, "POST", `/api/states/${s.entity}`, { ...auth(a), "Content-Type": "application/json" }, JSON.stringify({ state: s.state, attributes: s.attributes }));
  }
  return { published: a.states.map((s) => s.entity) };
}
