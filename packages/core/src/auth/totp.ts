// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — the variant every authenticator app supports.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, time = Date.now(), digits = 6, stepSeconds = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / stepSeconds)));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The time step a code matches: the current one or one either side, to tolerate clock drift. Null if none. */
export function totpStep(secret: string, code: string, time = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = Math.floor(time / 30_000);
  for (const step of [now - 1, now, now + 1]) {
    if (timingSafeEqual(Buffer.from(totpCode(secret, step * 30_000)), Buffer.from(code))) return step;
  }
  return null;
}

export function verifyTotp(secret: string, code: string, time = Date.now()): boolean {
  return totpStep(secret, code, time) !== null;
}

export function totpUri(secret: string, account: string, issuer = "MOSS"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
