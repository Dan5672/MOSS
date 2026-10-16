// dns_txt_lookup: TXT, MX, CNAME, CAA and NS records with their TTL. Node's resolver drops TTLs for these
// types, so this sends one plain DNS query over UDP to the same server Node's resolver (and dns_lookup) uses.
import type { DnsTxtLookupResult } from "@moss/tools";
import { randomInt } from "node:crypto";
import { createSocket } from "node:dgram";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export type RecordType = DnsTxtLookupResult["type"];
const TYPE_CODE: Record<RecordType, number> = { TXT: 16, MX: 15, CNAME: 5, CAA: 257, NS: 2 };
export const MAX_RECORDS = 50;
export const DNS_TIMEOUT_MS = 5_000;

export class DnsError extends Error {}

export function buildQuery(id: number, name: string, type: RecordType): Buffer {
  const labels = name.replace(/\.$/, "").split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "ascii")]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // recursion desired
  header.writeUInt16BE(1, 4); // one question
  header.writeUInt16BE(1, 10); // one additional: the EDNS record below
  const question = Buffer.alloc(4);
  question.writeUInt16BE(TYPE_CODE[type], 0);
  question.writeUInt16BE(1, 2); // class IN
  // EDNS0 OPT, advertising 4096-byte UDP answers so long TXT sets (SPF, DKIM keys) fit.
  const opt = Buffer.from([0, 0, 41, 0x10, 0x00, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([header, ...labels, Buffer.from([0]), question, opt]);
}

/** Reads a possibly compressed name; returns it and the offset just after it in the record. */
function readName(buf: Buffer, offset: number): [string, number] {
  const labels: string[] = [];
  let pos = offset;
  let end = -1;
  for (let jumps = 0; jumps < 64; jumps++) {
    const len = buf.readUInt8(pos);
    if (len === 0) return [labels.join("."), end >= 0 ? end : pos + 1];
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = pos + 2;
      pos = buf.readUInt16BE(pos) & 0x3fff;
      continue;
    }
    labels.push(buf.toString("latin1", pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  throw new DnsError("Malformed DNS answer");
}

export function parseAnswer(buf: Buffer, id: number, name: string, type: RecordType): DnsTxtLookupResult {
  try {
    return parse(buf, id, name, type);
  } catch (err) {
    // A reply that points past its own end is the server's fault: a tool error, not a crash.
    if (err instanceof RangeError) throw new DnsError("Malformed DNS answer");
    throw err;
  }
}

function parse(buf: Buffer, id: number, name: string, type: RecordType): DnsTxtLookupResult {
  if (buf.length < 12 || buf.readUInt16BE(0) !== id) throw new DnsError("Malformed DNS answer");
  const flags = buf.readUInt16BE(2);
  if (!(flags & 0x8000)) throw new DnsError("Malformed DNS answer: not a response");
  const rcode = flags & 0x0f;
  if (rcode === 3) return { name, type, records: [], noRecords: true }; // NXDOMAIN
  if (rcode !== 0) throw new DnsError(`DNS server answered with error code ${rcode}`);
  // shortcut: no TCP fallback for answers over 4 KB; add one if real domains hit it.
  if (flags & 0x0200) throw new DnsError("The answer is too large for a UDP DNS reply");
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  let pos = 12;
  for (let i = 0; i < qd; i++) pos = readName(buf, pos)[1] + 4;

  const records: DnsTxtLookupResult["records"] = [];
  let ttl: number | undefined;
  let truncated = false;
  for (let i = 0; i < an; i++) {
    pos = readName(buf, pos)[1];
    const rtype = buf.readUInt16BE(pos);
    const rttl = buf.readUInt32BE(pos + 4);
    const len = buf.readUInt16BE(pos + 8);
    const start = pos + 10;
    pos = start + len;
    if (pos > buf.length) throw new DnsError("Malformed DNS answer");
    if (rtype !== TYPE_CODE[type]) continue; // e.g. the CNAME a TXT name points through
    if (records.length >= MAX_RECORDS) {
      truncated = true;
      continue;
    }
    ttl = ttl === undefined ? rttl : Math.min(ttl, rttl);
    if (type === "TXT") {
      // One record is one or more strings of up to 255 bytes; they belong together (long SPF, DKIM keys).
      const parts: string[] = [];
      for (let p = start; p < pos; p += 1 + buf.readUInt8(p)) {
        if (p + 1 + buf.readUInt8(p) > pos) throw new DnsError("Malformed DNS answer");
        parts.push(buf.toString("utf8", p + 1, p + 1 + buf.readUInt8(p)));
      }
      records.push(parts.join(""));
    } else if (type === "MX") {
      records.push({ priority: buf.readUInt16BE(start), exchange: readName(buf, start + 2)[0] });
    } else if (type === "CAA") {
      const tagLen = buf.readUInt8(start + 1);
      if (start + 2 + tagLen > pos) throw new DnsError("Malformed DNS answer");
      records.push({ flags: buf.readUInt8(start), tag: buf.toString("latin1", start + 2, start + 2 + tagLen), value: buf.toString("utf8", start + 2 + tagLen, pos) });
    } else {
      records.push(readName(buf, start)[0]);
    }
  }
  if (!records.length) return { name, type, records: [], noRecords: true };
  return { name, type, ttl, records, ...(truncated ? { truncated } : {}) };
}

/** The first server Node's resolver uses, as host and port. */
export function resolverAddress(servers = dns.getServers()): { host: string; port: number } {
  const s = servers[0];
  if (!s) throw new DnsError("The toolbox has no DNS server configured");
  if (isIP(s)) return { host: s, port: 53 };
  const m = /^\[(.+)\]:(\d+)$/.exec(s) ?? /^([^:]+):(\d+)$/.exec(s);
  if (!m) throw new DnsError(`Unrecognised DNS server ${s}`);
  return { host: m[1]!, port: Number(m[2]) };
}

export function dnsTxtLookup(
  name: string,
  type: RecordType,
  server = resolverAddress(),
  timeoutMs = DNS_TIMEOUT_MS,
): Promise<DnsTxtLookupResult> {
  const id = randomInt(0, 0x10000);
  const socket = createSocket(isIP(server.host) === 6 ? "udp6" : "udp4");
  return new Promise<DnsTxtLookupResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DnsError(`DNS lookup timed out after ${timeoutMs / 1000} s`)), timeoutMs);
    const finish = () => clearTimeout(timer);
    socket.on("error", (err) => {
      finish();
      reject(new DnsError(`DNS lookup failed: ${err.message}`));
    });
    socket.on("message", (msg, from) => {
      // Ignore anything that isn't the server's reply to this query.
      if (from.address !== server.host || from.port !== server.port || msg.length < 2 || msg.readUInt16BE(0) !== id) return;
      finish();
      try {
        resolve(parseAnswer(msg, id, name, type));
      } catch (err) {
        reject(err);
      }
    });
    socket.send(buildQuery(id, name, type), server.port, server.host);
  }).finally(() => socket.close());
}
