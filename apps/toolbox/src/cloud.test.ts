// Tailscale and Cloudflare against stand-in APIs.
import { describe, expect, it } from "vitest";
import { cloudflareDns, cloudflareDnsRecord, cloudflareTunnels, tailscaleDevices } from "./cloud.js";

function api(routes: Record<string, unknown>, status = 200) {
  const calls: { url: string; method: string; auth?: string; body?: string }[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init?.method ?? "GET", auth: init?.headers?.Authorization, body: init?.body });
    const key = Object.keys(routes).find((k) => `${init?.method ?? "GET"} ${url}`.endsWith(k));
    return { status: key || !Object.keys(routes).length ? status : 404, json: async () => (key ? routes[key] : { success: false, errors: [{ message: "not found" }] }) };
  };
  return { fetchImpl, calls };
}

describe("Tailscale", () => {
  it("lists devices with their local addresses, online state and key expiry", async () => {
    const { fetchImpl, calls } = api({
      "/tailnet/-/devices?fields=all": {
        devices: [
          {
            nodeId: "n1",
            hostname: "nas",
            name: "nas.tail1234.ts.net",
            os: "linux",
            addresses: ["100.64.0.5", "fd7a:115c::5"],
            tags: ["tag:server"],
            connectedToControl: true,
            keyExpiryDisabled: false,
            expires: "2030-01-20T00:00:00Z",
            updateAvailable: true,
            clientConnectivity: { endpoints: ["192.168.1.10:41641", "203.0.113.7:41641"] },
          },
        ],
      },
    });
    const res = await tailscaleDevices({ apiKey: "tskey-api-x", tailnet: "-", timeoutMs: 5000 }, fetchImpl);
    expect(calls[0]).toMatchObject({ url: "https://api.tailscale.com/api/v2/tailnet/-/devices?fields=all", auth: "Bearer tskey-api-x" });
    expect(res.devices[0]).toMatchObject({ id: "n1", name: "nas", addresses: ["100.64.0.5", "fd7a:115c::5"], lanAddresses: ["192.168.1.10"], tags: ["tag:server"], online: true, updateAvailable: true });
    await expect(tailscaleDevices({ apiKey: "x", tailnet: "-", timeoutMs: 5000 }, api({}, 401).fetchImpl)).rejects.toThrow(/may have expired/);
  });
});

describe("Cloudflare", () => {
  const zone = { id: "z1", name: "example.com", account: { id: "acc1" } };

  it("lists zones with records, and tunnels with their public hostnames", async () => {
    const { fetchImpl } = api({
      "/zones?per_page=50": { success: true, result: [zone] },
      "/zones/z1/dns_records?per_page=500": { success: true, result: [{ id: "r1", type: "A", name: "home.example.com", content: "203.0.113.7", proxied: true, ttl: 1 }] },
      "/accounts/acc1/cfd_tunnel?is_deleted=false&per_page=100": { success: true, result: [{ id: "t1", name: "home", status: "healthy", connections: [{}, {}] }] },
      "/accounts/acc1/cfd_tunnel/t1/configurations": { success: true, result: { config: { ingress: [{ hostname: "ha.example.com", service: "http://10.0.0.20:8123" }, { service: "http_status:404" }] } } },
    });
    expect((await cloudflareDns({ apiToken: "t", timeoutMs: 5000 }, fetchImpl)).zones).toEqual([
      { id: "z1", name: "example.com", accountId: "acc1", records: [{ id: "r1", type: "A", name: "home.example.com", content: "203.0.113.7", proxied: true, ttl: 1 }] },
    ]);
    expect((await cloudflareTunnels({ apiToken: "t", timeoutMs: 5000 }, fetchImpl)).tunnels).toEqual([{ id: "t1", name: "home", status: "healthy", connections: 2, hostnames: ["ha.example.com"] }]);
  });

  it("creates a record, or updates the one that's there", async () => {
    const { fetchImpl, calls } = api({
      "GET https://api.cloudflare.com/client/v4/zones?name=example.com": { success: true, result: [zone] },
      "GET https://api.cloudflare.com/client/v4/zones/z1/dns_records?type=A&name=moss.example.com": { success: true, result: [] },
      "POST https://api.cloudflare.com/client/v4/zones/z1/dns_records": { success: true, result: { name: "moss.example.com", type: "A", content: "10.0.0.213", proxied: false } },
    });
    const res = await cloudflareDnsRecord({ apiToken: "t", zone: "example.com", action: "upsert", type: "A", name: "moss.example.com", content: "10.0.0.213", proxied: false, timeoutMs: 5000 }, fetchImpl);
    expect(res).toEqual({ name: "moss.example.com", type: "A", content: "10.0.0.213", proxied: false, created: true });
    expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({ type: "A", name: "moss.example.com", content: "10.0.0.213", proxied: false });
    await expect(cloudflareDns({ apiToken: "t", timeoutMs: 5000 }, api({}, 403).fetchImpl)).rejects.toThrow(/rejected the API token/);
  });
});
