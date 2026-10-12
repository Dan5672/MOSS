// Minimal IPv4/IPv6 range math, so the policy core has no dependencies.

export interface IpRange {
  version: 4 | 6;
  start: bigint;
  end: bigint;
}

function parseV4(addr: string): bigint | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    // No leading zeros: URL parsers and resolvers read 010 as octal (8), which would reach another host than the one checked.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseV6(addr: string): bigint | null {
  if (addr.includes("%")) return null; // zone IDs are not valid policy targets
  let head = addr;
  let tailV4: bigint | null = null;
  // Embedded IPv4 suffix, e.g. ::ffff:192.168.1.1
  const lastColon = addr.lastIndexOf(":");
  if (addr.includes(".") && lastColon !== -1) {
    tailV4 = parseV4(addr.slice(lastColon + 1));
    if (tailV4 === null) return null;
    head = addr.slice(0, lastColon + 1) + "0:0";
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const left = toGroups(halves[0] ?? "");
  const right = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  if (tailV4 !== null) value = (value & ~0xffffffffn) | tailV4;
  return value;
}

/** Parses an IP address or CIDR into an inclusive range. Returns null for anything else (e.g. hostnames). */
export function parseRange(input: string): IpRange | null {
  const [addr, prefixStr, extra] = input.trim().split("/");
  if (addr === undefined || extra !== undefined) return null;
  const v4 = parseV4(addr);
  const version: 4 | 6 = v4 !== null ? 4 : 6;
  const value = v4 ?? parseV6(addr);
  if (value === null) return null;
  const bits = version === 4 ? 32 : 128;
  let prefix = bits;
  if (prefixStr !== undefined) {
    if (!/^\d{1,3}$/.test(prefixStr)) return null;
    prefix = Number(prefixStr);
    if (prefix > bits) return null;
  }
  const hostBits = BigInt(bits - prefix);
  const mask = ((1n << BigInt(bits)) - 1n) ^ ((1n << hostBits) - 1n);
  const start = value & mask;
  const end = start | ((1n << hostBits) - 1n);
  // An IPv4-mapped address (::ffff:192.168.1.5) reaches the IPv4 host, so it is that IPv4 range for every rule.
  if (version === 6 && prefix >= 96 && start >> 32n === 0xffffn) return { version: 4, start: start & 0xffffffffn, end: end & 0xffffffffn };
  return { version, start, end };
}

export function contains(outer: IpRange, inner: IpRange): boolean {
  return outer.version === inner.version && outer.start <= inner.start && inner.end <= outer.end;
}

export function overlaps(a: IpRange, b: IpRange): boolean {
  return a.version === b.version && a.start <= b.end && b.start <= a.end;
}

function formatV6(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, i) => Number((value >> BigInt((7 - i) * 16)) & 0xffffn));
  // Compress the longest run of two or more zero groups (RFC 5952).
  let best = { start: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.len && j - i >= 2) best = { start: i, len: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.start === -1) return hex.join(":");
  return `${hex.slice(0, best.start).join(":")}::${hex.slice(best.start + best.len).join(":")}`;
}

export function formatAddress(version: 4 | 6, value: bigint): string {
  if (version === 6) return formatV6(value);
  return [24n, 16n, 8n, 0n].map((s) => String((value >> s) & 255n)).join(".");
}

/** Canonical network form of an IP/CIDR ("192.168.1.77/24" -> "192.168.1.0/24"), or null if invalid. */
export function canonicalCidr(input: string): string | null {
  const range = parseRange(input);
  if (!range) return null;
  const bits = range.version === 4 ? 32 : 128;
  const size = range.end - range.start + 1n;
  const prefix = bits - (size.toString(2).length - 1);
  return `${formatAddress(range.version, range.start)}/${prefix}`;
}

/**
 * Private, internal and special-use addresses: RFC 1918, CGNAT (100.64/10), loopback, link-local, benchmarking,
 * multicast and reserved, and the IPv6 equivalents. Anything else is a public address on the internet.
 */
const PRIVATE_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "0.0.0.0/8",
  "192.0.0.0/24",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "::/128",
  // NAT64 (64:ff9b::/96) and IPv4-compatible (::/96) addresses carry an IPv4 address that may be on the LAN.
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "::/96",
  // 6to4 carries an IPv4 address too.
  "2002::/16",
].map((c) => parseRange(c)!);

// Public IPv6 addresses are global unicast; everything outside it (multicast, reserved) is not.
const GLOBAL_UNICAST = parseRange("2000::/3")!;

/** True if any part of the range is private or special-use (so a range straddling both counts as private). */
export function isPrivateRange(range: IpRange): boolean {
  if (range.version === 6 && !contains(GLOBAL_UNICAST, range)) return true;
  return PRIVATE_RANGES.some((p) => p.version === range.version && overlaps(p, range));
}

/** One address in canonical form ("::ffff:192.168.1.5" -> "192.168.1.5"), or null if it isn't a single address. */
export function canonicalAddress(input: string): string | null {
  const range = parseRange(input);
  return range && range.start === range.end ? formatAddress(range.version, range.start) : null;
}
