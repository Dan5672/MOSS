// Fortinet FortiGate, read-only through FortiOS's REST API with a REST API administrator's token (a read-only admin
// profile): DHCP leases, SD-WAN health checks (as gateways), IPsec tunnels, HA and firmware. Anything the profile
// may not read is left out rather than failing the whole read.
import { sendRequest, type RawRequest } from "./custom-http.js";
import { arr, call, HomelabError, num, obj, type Base } from "./homelab.js";
import { clean } from "./parsers.js";

type FgArgs = Base & { apiToken: string; vdom?: string };

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

export async function fortigateStatus(a: FgArgs, send: RawRequest = sendRequest) {
  const h = { Authorization: `Bearer ${a.apiToken}`, Accept: "application/json" };
  const vdom = a.vdom ? `?vdom=${encodeURIComponent(a.vdom)}` : "";
  const get = async (path: string) => obj((await call(send, "FortiGate", a, "GET", `${path}${vdom}`, h)).json);
  const maybe = async (path: string) => {
    try {
      return await get(path);
    } catch (err) {
      // 403 is a section the admin profile doesn't cover: leave it out. 401 is a bad token: stop.
      if (/HTTP 401/.test((err as Error).message)) throw err;
      return null;
    }
  };
  let status: Record<string, unknown>;
  try {
    status = await get("/api/v2/monitor/system/status");
  } catch (err) {
    if (/HTTP 403/.test((err as Error).message)) throw new HomelabError("The FortiGate refused the token from here: add MOSS's address to the REST API admin's Trusted Hosts, and give its profile read access");
    throw err;
  }
  const [dhcp, sdwan, ipsec, firmware, ha] = await Promise.all([
    maybe("/api/v2/monitor/system/dhcp"),
    maybe("/api/v2/monitor/virtual-wan/health-check"),
    maybe("/api/v2/monitor/vpn/ipsec"),
    maybe("/api/v2/monitor/system/firmware"),
    maybe("/api/v2/monitor/system/ha-statistics"),
  ]);

  const seen = new Set<string>();
  const leases = arr(dhcp?.results)
    .flatMap((l) => {
      const ip = clean(l.ip);
      if (!ip || seen.has(ip)) return [];
      seen.add(ip);
      const mac = String(l.mac ?? "").toLowerCase();
      return [{ ip, mac: MAC.test(mac) ? mac : undefined, hostname: clean(l.hostname) || undefined }];
    })
    .slice(0, 1000);

  // SD-WAN: each health check's member links, as "gateways".
  const gateways = Object.entries(obj(sdwan?.results)).flatMap(([check, members]) =>
    Object.entries(obj(members)).map(([member, raw]) => {
      const m = obj(raw);
      const st = clean(m.status) ?? "unknown";
      return { name: `${check}/${member}`, online: st === "up", status: st, lossPercent: num(m.packet_loss), delayMs: num(m.latency) === undefined ? undefined : Math.round(num(m.latency)! * 10) / 10 };
    }),
  );

  const tunnels = arr(ipsec?.results).map((t) => {
    const selectors = arr(t.proxyid);
    const up = selectors.filter((p) => p.status === "up").length;
    return { name: clean(t.name) ?? "?", remote: clean(t.rgwy), up: up > 0, selectorsUp: up, selectors: selectors.length };
  });

  const current = clean(obj(obj(firmware?.results).current).version) ?? clean(status.version);
  const newer = arr(obj(firmware?.results).available)
    .map((f) => clean(f.version))
    .filter((v): v is string => !!v && v !== current);

  const haMembers = Array.isArray(ha?.results) ? arr(ha?.results).length : 0;

  return {
    product: "fortigate" as const,
    version: clean(status.version),
    hostname: clean(obj(status.results).hostname),
    model: clean(obj(status.results).model_name) ?? clean(obj(status.results).model),
    leases,
    gateways,
    tunnels,
    ha: haMembers ? { members: haMembers } : undefined,
    update: newer.length ? { available: true, message: `FortiOS ${newer[0]} is available (running ${current})` } : { available: false },
  };
}
