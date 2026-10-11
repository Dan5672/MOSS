// Cisco Meraki against a stand-in Dashboard API.
import { describe, expect, it } from "vitest";
import { merakiDevices, merakiNetwork } from "./meraki.js";

function api(routes: Record<string, unknown>, status: Record<string, number> = {}) {
  const calls: { url: string; auth?: string }[] = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const path = url.replace("https://api.meraki.com/api/v1", "");
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const code = Object.entries(status).find(([k]) => path.startsWith(k))?.[1];
    return { status: code ?? (key ? 200 : 404), json: async () => (key ? routes[key] : {}) };
  };
  return { fetchImpl, calls };
}

describe("Cisco Meraki", () => {
  it("reads devices, uplinks with their latest loss and latency, and VPN peers", async () => {
    const { fetchImpl, calls } = api({
      "/organizations/o1/devices/statuses": [
        { serial: "Q2-MX", name: "Office MX", model: "MX68", productType: "appliance", status: "online", mac: "AA:BB:CC:00:00:01", lanIp: "10.0.0.1" },
        { serial: "Q2-AP", name: "", model: "MR36", productType: "wireless", status: "offline" },
      ],
      "/organizations/o1/devices/uplinksLossAndLatency": [{ serial: "Q2-MX", uplink: "wan1", timeSeries: [{ lossPercent: 0, latencyMs: 12 }, { lossPercent: 1.2, latencyMs: 18.5 }] }],
      "/organizations/o1/appliance/uplink/statuses": [{ serial: "Q2-MX", uplinks: [{ interface: "wan1", status: "active", ip: "203.0.113.2" }, { interface: "wan2", status: "failed" }] }],
      "/organizations/o1/appliance/vpn/statuses": [{ networkName: "Office", merakiVpnPeers: [{ networkName: "Branch", reachability: "unreachable" }], thirdPartyVpnPeers: [{ name: "AWS", reachability: "reachable" }] }],
      "/organizations": [{ id: "o1", name: "Acme" }],
    });
    const res = await merakiDevices({ apiKey: "k", timeoutMs: 5000 }, fetchImpl);
    expect(calls[0]).toEqual({ url: "https://api.meraki.com/api/v1/organizations", auth: "Bearer k" });
    expect(res).toEqual({
      organizations: ["Acme"],
      devices: [
        expect.objectContaining({ serial: "Q2-MX", name: "Office MX", type: "appliance", status: "online", mac: "aa:bb:cc:00:00:01", lanIp: "10.0.0.1", org: "Acme" }),
        expect.objectContaining({ serial: "Q2-AP", name: "Q2-AP", status: "offline" }),
      ],
      uplinks: [
        { serial: "Q2-MX", interface: "wan1", status: "active", ip: "203.0.113.2", publicIp: undefined, lossPercent: 1.2, latencyMs: 18.5 },
        { serial: "Q2-MX", interface: "wan2", status: "failed", ip: undefined, publicIp: undefined, lossPercent: undefined, latencyMs: undefined },
      ],
      vpnPeers: [
        { network: "Office", peer: "Branch", reachable: false },
        { network: "Office", peer: "AWS", reachable: true },
      ],
    });
  });

  it("reads clients per network, and says when the key is refused", async () => {
    const { fetchImpl } = api({
      "/organizations/o1/networks": [{ id: "N1", name: "Office" }],
      "/networks/N1/clients": [{ id: "k1", mac: "AA:BB:CC:00:00:50", ip: "10.0.0.50", description: "Reception PC", manufacturer: "Dell", os: "Windows 11" }],
      "/organizations": [{ id: "o1", name: "Acme" }],
    });
    expect((await merakiNetwork({ apiKey: "k", timeoutMs: 5000 }, fetchImpl)).clients).toEqual([{ id: "k1", mac: "aa:bb:cc:00:00:50", ip: "10.0.0.50", name: "Reception PC", vendor: "Dell", os: "Windows 11", network: "Office" }]);
    await expect(merakiDevices({ apiKey: "bad", timeoutMs: 5000 }, api({}, { "/organizations": 401 }).fetchImpl)).rejects.toThrow("Meraki rejected the API key");
  });
});
