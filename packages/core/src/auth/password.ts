// Password hashing with scrypt (memory-hard, built into Node; no native deps for ARM/x86 images).
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LEN = 32;
const MAX_MEM = 128 * PARAMS.N * PARAMS.r * 2;

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { ...PARAMS, maxmem: MAX_MEM });
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    ...params,
    maxmem: 128 * params.N * params.r * 2,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
