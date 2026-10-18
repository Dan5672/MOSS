import { dnsTxtLookup as dnsTxtLookupTool, parseToolArgs } from "@moss/tools";
import { createSocket, type Socket } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { buildQuery, dnsTxtLookup, MAX_RECORDS, parseAnswer, resolverAddress } from "./dns-records.js";

const TYPES = { TXT: 16, MX: 15, CNAME: 5, CAA: 257, NS: 2 } as const;

/** A reply to `query`: its header and question, then answer records (each pointing at the question name). */
function reply(query: Buffer, answers: { type: number; ttl: number; rdata: Buffer }[], rcode = 0): Buffer {
  const qEnd = query.length - 11; // drop the EDNS record
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8180 | rcode, 2);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 10);
  const rrs = answers.map(({ type, ttl, rdata }) => {
    const rr = Buffer.alloc(12);
    rr.writeUInt16BE(0xc00c, 0); // pointer to the question name
    rr.writeUInt16BE(type, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(ttl, 6);
    rr.writeUInt16BE(rdata.length, 10);
    return Buffer.concat([rr, rdata]);
  });
  return Buffer.concat([header, query.subarray(12, qEnd), ...rrs]);
}
const strings = (...s: string[]) => Buffer.concat(s.flatMap((x) => [Buffer.from([x.length]), Buffer.from(x)]));
const name = (n: string) => Buffer.concat([...n.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);

describe("dns_txt_lookup answers", () => {
  it("joins a TXT record's strings and reports the lowest TTL", () => {
    const q = buildQuery(7, "example.com", "TXT");
    const a = reply(q, [
      { type: TYPES.TXT, ttl: 300, rdata: strings("v=spf1 include:_spf.google.com ", "~all") },
      { type: TYPES.TXT, ttl: 120, rdata: strings("google-site-verification=abc") },
    ]);
    expect(parseAnswer(a, 7, "example.com", "TXT")).toEqual({
      name: "example.com",
      type: "TXT",
      ttl: 120,
      records: ["v=spf1 include:_spf.google.com ~all", "google-site-verification=abc"],
    });
  });

  it("reads MX, CAA and NS records, skipping a CNAME on the way", () => {
    const mx = buildQuery(1, "example.com", "MX");
    const mxRdata = Buffer.concat([Buffer.from([0, 10]), name("mail.example.com")]);
    const cname = { type: TYPES.CNAME, ttl: 60, rdata: name("other.example.com") };
    expect(parseAnswer(reply(mx, [cname, { type: TYPES.MX, ttl: 3600, rdata: mxRdata }]), 1, "example.com", "MX")).toMatchObject({
      ttl: 3600,
      records: [{ priority: 10, exchange: "mail.example.com" }],
    });
    const caa = buildQuery(2, "example.com", "CAA");
    const caaRdata = Buffer.concat([Buffer.from([0, 5]), Buffer.from("issueletsencrypt.org")]);
    expect(parseAnswer(reply(caa, [{ type: TYPES.CAA, ttl: 60, rdata: caaRdata }]), 2, "example.com", "CAA").records).toEqual([
      { flags: 0, tag: "issue", value: "letsencrypt.org" },
    ]);
    const ns = buildQuery(3, "example.com", "NS");
    expect(parseAnswer(reply(ns, [{ type: TYPES.NS, ttl: 60, rdata: name("ns1.example.net") }]), 3, "example.com", "NS").records).toEqual(["ns1.example.net"]);
  });

  it("says there are no records for NXDOMAIN and for an empty answer", () => {
    const q = buildQuery(9, "nope.example.com", "TXT");
    expect(parseAnswer(reply(q, [], 3), 9, "nope.example.com", "TXT")).toEqual({ name: "nope.example.com", type: "TXT", records: [], noRecords: true });
    expect(parseAnswer(reply(q, []), 9, "nope.example.com", "TXT")).toMatchObject({ records: [], noRecords: true });
    expect(() => parseAnswer(reply(q, [], 2), 9, "nope.example.com", "TXT")).toThrow(/error code 2/);
  });

  it("refuses replies that aren't answers or point past their own end", () => {
    const q = buildQuery(5, "example.com", "TXT");
    const notReply = Buffer.from(reply(q, []));
    notReply.writeUInt16BE(0x0100, 2); // QR bit clear: a query, not a response
    expect(() => parseAnswer(notReply, 5, "example.com", "TXT")).toThrow(/not a response/);
    const overlong = reply(q, [{ type: TYPES.TXT, ttl: 60, rdata: Buffer.from([200, 0x61]) }]); // a 200-byte string in 2 bytes
    expect(() => parseAnswer(overlong, 5, "example.com", "TXT")).toThrow(/Malformed/);
    const cut = reply(q, [{ type: TYPES.TXT, ttl: 60, rdata: strings("abc") }]).subarray(0, -2);
    expect(() => parseAnswer(cut, 5, "example.com", "TXT")).toThrow(/Malformed/);
    const badCaa = reply(buildQuery(6, "example.com", "CAA"), [{ type: TYPES.CAA, ttl: 60, rdata: Buffer.from([0, 50, 0x69]) }]);
    expect(() => parseAnswer(badCaa, 6, "example.com", "CAA")).toThrow(/Malformed/);
  });

  it("caps the records returned", () => {
    const q = buildQuery(4, "example.com", "TXT");
    const many = Array.from({ length: MAX_RECORDS + 10 }, (_, i) => ({ type: TYPES.TXT, ttl: 60, rdata: strings(`r${i}`) }));
    const res = parseAnswer(reply(q, many), 4, "example.com", "TXT");
    expect(res.records).toHaveLength(MAX_RECORDS);
    expect(res.truncated).toBe(true);
  });

  it("refuses IPs, reverse names and anything that isn't a hostname", () => {
    const ok = (n: string) => parseToolArgs(dnsTxtLookupTool, { name: n }).ok;
    for (const n of ["example.com", "_dmarc.example.com", "selector1._domainkey.example.com", "example.com."]) expect(ok(n), n).toBe(true);
    for (const n of ["", "8.8.8.8", "1.168.192.in-addr.arpa", "::1", "a b.com", "x;rm.com", "a..b.com", `${"a".repeat(64)}.com`, "a".repeat(254)]) {
      expect(ok(n), n).toBe(false);
    }
    expect(parseToolArgs(dnsTxtLookupTool, { name: "example.com", type: "A" }).ok).toBe(false);
    expect(parseToolArgs(dnsTxtLookupTool, { name: "example.com" })).toMatchObject({ ok: true, args: { type: "TXT" } });
  });

  it("reads the resolver's address the way Node lists it", () => {
    expect(resolverAddress(["127.0.0.11"])).toEqual({ host: "127.0.0.11", port: 53 });
    expect(resolverAddress(["10.0.0.1:5353"])).toEqual({ host: "10.0.0.1", port: 5353 });
    expect(resolverAddress(["[::1]:53"])).toEqual({ host: "::1", port: 53 });
    expect(resolverAddress(["fd00::1"])).toEqual({ host: "fd00::1", port: 53 });
  });
});

describe("dns_txt_lookup over UDP", () => {
  let server: Socket | undefined;
  afterEach(() => server?.close());

  const listen = (onQuery?: (q: Buffer) => Buffer) =>
    new Promise<number>((resolve) => {
      server = createSocket("udp4");
      server.on("message", (q, from) => onQuery && server!.send(onQuery(q), from.port, from.address));
      server.bind(0, "127.0.0.1", () => resolve(server!.address().port));
    });

  it("asks the server and parses its reply", async () => {
    const port = await listen((q) => reply(q, [{ type: TYPES.TXT, ttl: 42, rdata: strings("v=DMARC1; p=reject") }]));
    expect(await dnsTxtLookup("_dmarc.example.com", "TXT", { host: "127.0.0.1", port })).toEqual({
      name: "_dmarc.example.com",
      type: "TXT",
      ttl: 42,
      records: ["v=DMARC1; p=reject"],
    });
  });

  it("times out when the server doesn't answer", async () => {
    const port = await listen();
    await expect(dnsTxtLookup("example.com", "TXT", { host: "127.0.0.1", port }, 200)).rejects.toThrow(/timed out/);
  });
});
