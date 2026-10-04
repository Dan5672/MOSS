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
    if (!/^\d{1,3}$/.test(part)) return null;
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
  return { version, start, end };
}

export function contains(outer: IpRange, inner: IpRange): boolean {
  return outer.version === inner.version && outer.start <= inner.start && inner.end <= outer.end;
}

export function overlaps(a: IpRange, b: IpRange): boolean {
  return a.version === b.version && a.start <= b.end && b.start <= a.end;
}
