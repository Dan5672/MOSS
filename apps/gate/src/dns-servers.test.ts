import { describe, expect, it } from "vitest";
import { dnsServersFor } from "./service.js";

describe("dnsServersFor", () => {
  const nets = [
    { cidr: "10.0.0.0/16", dnsServer: "10.0.0.1" },
    { cidr: "10.0.5.0/24", dnsServer: "10.0.5.1" },
    { cidr: "192.168.1.0/24", dnsServer: null },
  ];
  it("uses the most specific network's DNS server for each target", () => {
    expect(dnsServersFor(["10.0.5.0/24"], nets)).toEqual(["10.0.5.1"]);
    expect(dnsServersFor(["10.0.9.4", "10.0.5.7"], nets)).toEqual(["10.0.0.1", "10.0.5.1"]);
  });
  it("is empty when no network has one", () => {
    expect(dnsServersFor(["192.168.1.0/24", "172.16.0.1"], nets)).toEqual([]);
  });
});
