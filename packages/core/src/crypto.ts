// Envelope encryption for the secrets broker. Each secret is encrypted with its
// own random data key (AES-256-GCM); the data key is wrapped with the master key.
// Rotating the master key only requires re-wrapping data keys, not re-encrypting values.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface EncryptedSecret {
  ciphertext: string;
  wrappedDataKey: string;
}

function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function open(key: Buffer, sealed: string, aad: string): Buffer {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Sealed value is truncated");
  const decipher = createDecipheriv(ALGO, key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

function assertKey(masterKey: Buffer) {
  if (masterKey.length !== KEY_BYTES) throw new Error(`Master key must be ${KEY_BYTES} bytes`);
}

export function generateMasterKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Parses a master key file: 32 raw bytes, or 64 hex / 44 base64 characters. */
export function parseMasterKey(contents: Buffer): Buffer {
  const text = contents.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  const b64 = Buffer.from(text, "base64");
  if (b64.length === KEY_BYTES && /^[A-Za-z0-9+/]+=*$/.test(text)) return b64;
  if (contents.length === KEY_BYTES) return contents;
  throw new Error("Master key file must contain 32 bytes (raw, hex or base64)");
}

/**
 * Encrypts a secret value. `secretId` is bound in as associated data, so a
 * ciphertext copied onto another secret's row will fail to decrypt.
 */
export function encryptSecret(masterKey: Buffer, secretId: string, plaintext: string): EncryptedSecret {
  assertKey(masterKey);
  const dataKey = randomBytes(KEY_BYTES);
  try {
    return {
      ciphertext: seal(dataKey, Buffer.from(plaintext, "utf8"), `value:${secretId}`),
      wrappedDataKey: seal(masterKey, dataKey, `dek:${secretId}`),
    };
  } finally {
    dataKey.fill(0);
  }
}

export function decryptSecret(masterKey: Buffer, secretId: string, secret: EncryptedSecret): string {
  assertKey(masterKey);
  const dataKey = open(masterKey, secret.wrappedDataKey, `dek:${secretId}`);
  try {
    return open(dataKey, secret.ciphertext, `value:${secretId}`).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}

/** Re-wraps a data key under a new master key (master key rotation). */
export function rewrapDataKey(oldKey: Buffer, newKey: Buffer, secretId: string, wrappedDataKey: string): string {
  assertKey(oldKey);
  assertKey(newKey);
  const dataKey = open(oldKey, wrappedDataKey, `dek:${secretId}`);
  try {
    return seal(newKey, dataKey, `dek:${secretId}`);
  } finally {
    dataKey.fill(0);
  }
}
