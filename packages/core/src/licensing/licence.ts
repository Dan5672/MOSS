// Business licence keys: MOSS1.<payload>.<signature>, both base64url. The payload is JSON; the signature is Ed25519
// over "MOSS1.<payload>", made with the private key kept by whoever sells MOSS, never in this repository. MOSS
// checks keys offline against the public keys below: nothing calls home.
//
// MOSS is open source, so anyone can remove these checks from their own copy. A key makes paying the normal path
// and stops casual use; it isn't DRM.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";

export const LICENCE_PREFIX = "MOSS1";

/** Public keys that may sign licences, by key id (base64 SPKI DER). A new key id lets a signing key be replaced. */
export const LICENCE_PUBLIC_KEYS: Record<string, string> = {
  "moss-2026": "MCowBQYDK2VwAyEAhVkMedIiUFDADMkC9r2VZW8GH7EKtlC37IWFv8jd83w=",
};

/** Days a business licence keeps working after it expires, with a warning, so a late renewal breaks nothing. */
export const LICENCE_GRACE_DAYS = 14;

const isoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "an ISO time");

export const licencePayloadSchema = z
  .object({
    v: z.literal(1),
    /** Which signing key made it. */
    kid: z.string().regex(/^[a-z0-9-]{1,40}$/),
    id: z.string().min(1).max(100),
    licensee: z.string().min(1).max(200),
    plan: z.literal("business"),
    /** Integration keys it covers, or "*" for all of them. */
    features: z.array(z.string().min(1).max(60)).min(1).max(100),
    maxUsers: z.number().int().positive().optional(),
    issued: isoTime,
    expires: isoTime,
  })
  .strict();

export type LicencePayload = z.infer<typeof licencePayloadSchema>;

const b64url = (b: Buffer) => b.toString("base64url");

/**
 * A setting that only tests may use (another licence key, a stand-in sign-in page). MOSS's images set MOSS_IMAGE,
 * so an installed MOSS ignores them whatever its environment says.
 */
export function testOverride(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  return env.MOSS_IMAGE ? undefined : env[name]?.trim() || undefined;
}

/** The public keys MOSS accepts: the built-in ones, plus MOSS_LICENCE_EXTRA_PUBLIC_KEY ("kid:base64") for tests. */
export function licencePublicKeys(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const extra = testOverride("MOSS_LICENCE_EXTRA_PUBLIC_KEY", env);
  const m = extra ? /^([a-z0-9-]{1,40}):([A-Za-z0-9+/=]+)$/.exec(extra) : null;
  // It can add a key, never replace a built-in one.
  return m && !(m[1]! in LICENCE_PUBLIC_KEYS) ? { ...LICENCE_PUBLIC_KEYS, [m[1]!]: m[2]! } : LICENCE_PUBLIC_KEYS;
}

/** Signs a licence (for scripts/licence.mjs and tests; MOSS itself never holds a private key). */
export function signLicence(payload: LicencePayload, privateKeyPem: string): string {
  const parsed = licencePayloadSchema.parse(payload);
  const body = `${LICENCE_PREFIX}.${b64url(Buffer.from(JSON.stringify(parsed)))}`;
  return `${body}.${b64url(sign(null, Buffer.from(body), createPrivateKey(privateKeyPem)))}`;
}

export type LicenceCheck = { ok: true; licence: LicencePayload } | { ok: false; error: string };

/** Checks a key's signature and contents (not whether it has expired: see licenceStatus). */
export function verifyLicence(text: string, keys: Record<string, string> = licencePublicKeys()): LicenceCheck {
  const parts = text.trim().replace(/\s+/g, "").split(".");
  if (parts.length !== 3 || parts[0] !== LICENCE_PREFIX) return { ok: false, error: "That isn't a MOSS licence key." };
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "That licence key is damaged." };
  }
  const parsed = licencePayloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: "That licence key is damaged." };
  const key = keys[parsed.data.kid];
  if (!key) return { ok: false, error: "That licence key wasn't issued for this version of MOSS." };
  let good = false;
  try {
    const pub = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
    good = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), pub, Buffer.from(parts[2]!, "base64url"));
  } catch {
    good = false;
  }
  return good ? { ok: true, licence: parsed.data } : { ok: false, error: "That licence key isn't genuine (its signature doesn't match)." };
}

export type LicenceState = "none" | "valid" | "grace" | "expired";

export interface LicenceStatus {
  state: LicenceState;
  licence: LicencePayload | null;
  /** Whole days until it expires (negative once it has). */
  daysLeft: number | null;
  /** When business features stop (expiry plus the grace period). */
  stopsAt: string | null;
}

export function licenceStatus(licence: LicencePayload | null, now = new Date()): LicenceStatus {
  if (!licence) return { state: "none", licence: null, daysLeft: null, stopsAt: null };
  const expires = Date.parse(licence.expires);
  const stops = expires + LICENCE_GRACE_DAYS * 86_400_000;
  const daysLeft = Math.ceil((expires - now.getTime()) / 86_400_000);
  const state: LicenceState = now.getTime() < expires ? "valid" : now.getTime() < stops ? "grace" : "expired";
  return { state, licence, daysLeft, stopsAt: new Date(stops).toISOString() };
}

/** Whether a licence in this state lets a business integration work. */
export function licenceCovers(status: LicenceStatus, key: string): boolean {
  if (status.state !== "valid" && status.state !== "grace") return false;
  const f = status.licence!.features;
  return f.includes("*") || f.includes(key);
}
