// Business licence keys: signing, checking, expiry and what they cover.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { integrationAllowed } from "./licensing/service.js";
import { licenceCovers, licencePublicKeys, licenceStatus, signLicence, verifyLicence, type LicencePayload } from "./licensing/licence.js";

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};
const k = pair();
const keys = { test: k.pub };
const payload = (over: Partial<LicencePayload> = {}): LicencePayload => ({
  v: 1,
  kid: "test",
  id: "lic-1",
  licensee: "Acme Ltd",
  plan: "business",
  features: ["*"],
  issued: "2030-01-01T00:00:00.000Z",
  expires: "2031-01-01T00:00:00.000Z",
  ...over,
});

describe("licence keys", () => {
  it("accepts a genuine key, with spaces or line breaks pasted in", () => {
    const key = signLicence(payload(), k.pem);
    expect(verifyLicence(key, keys)).toEqual({ ok: true, licence: payload() });
    expect(verifyLicence(`  ${key.slice(0, 40)}\n${key.slice(40)} `, keys).ok).toBe(true);
  });

  it("refuses a changed, foreign or garbled key", () => {
    const key = signLicence(payload(), k.pem);
    const [pre, body, sig] = key.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload(), licensee: "Mallory" })).toString("base64url");
    expect(verifyLicence(`${pre}.${forged}.${sig}`, keys)).toEqual({ ok: false, error: "That licence key isn't genuine (its signature doesn't match)." });
    expect(verifyLicence(signLicence(payload(), pair().pem), keys).ok).toBe(false);
    expect(verifyLicence(signLicence(payload({ kid: "other" }), k.pem), keys)).toMatchObject({ error: /wasn't issued for this version/ });
    expect(verifyLicence(`${pre}.${body}`, keys)).toMatchObject({ error: "That isn't a MOSS licence key." });
    expect(verifyLicence("MOSS1.not-json.x", keys)).toMatchObject({ error: "That licence key is damaged." });
  });

  it("works until expiry, then for a 14-day grace period, then stops", () => {
    const l = payload();
    expect(licenceStatus(l, new Date("2030-12-25T00:00:00Z"))).toMatchObject({ state: "valid", daysLeft: 7 });
    expect(licenceStatus(l, new Date("2031-01-10T00:00:00Z"))).toMatchObject({ state: "grace", stopsAt: "2031-01-15T00:00:00.000Z" });
    expect(licenceStatus(l, new Date("2031-01-16T00:00:00Z")).state).toBe("expired");
    expect(licenceStatus(null).state).toBe("none");
  });

  it("covers the integrations it lists, and free ones never need it", () => {
    const now = new Date("2030-06-01T00:00:00Z");
    const some = licenceStatus(payload({ features: ["m365", "slack"] }), now);
    expect([licenceCovers(some, "slack"), licenceCovers(some, "aws")]).toEqual([true, false]);
    expect(licenceCovers(licenceStatus(payload(), now), "aws")).toBe(true);
    expect(integrationAllowed({ key: "aws", plan: "business" }, licenceStatus(null))).toBe(false);
    expect(integrationAllowed({ key: "pihole", plan: "free" }, licenceStatus(null))).toBe(true);
    expect(integrationAllowed({ key: "aws", plan: "business" }, licenceStatus(payload(), new Date("2032-01-01T00:00:00Z")))).toBe(false);
  });

  it("takes an extra public key from the environment (for tests), alongside the built-in ones", () => {
    expect(licencePublicKeys({ MOSS_LICENCE_EXTRA_PUBLIC_KEY: `e2e:${k.pub}` })).toMatchObject({ "moss-2026": expect.any(String), e2e: k.pub });
    expect(Object.keys(licencePublicKeys({ MOSS_LICENCE_EXTRA_PUBLIC_KEY: "not a key" }))).toEqual(["moss-2026"]);
    expect(licencePublicKeys({ MOSS_LICENCE_EXTRA_PUBLIC_KEY: `moss-2026:${k.pub}` })["moss-2026"]).not.toBe(k.pub);
  });

  it("verifies keys made by scripts/licence.mjs", () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-lic-"));
    writeFileSync(join(dir, "test.key"), k.pem);
    const script = join(__dirname, "../../../scripts/licence.mjs");
    const key = execFileSync(process.execPath, [script, "issue", "--licensee", "Acme Ltd", "--expires", "2031-03-31", "--features", "m365,aws", "--max-users", "25"], {
      env: { ...process.env, MOSS_LICENSING_DIR: dir },
    })
      .toString()
      .trim();
    expect(verifyLicence(key, keys)).toMatchObject({ ok: true, licence: { licensee: "Acme Ltd", features: ["m365", "aws"], maxUsers: 25, expires: "2031-03-31T23:59:59.000Z", kid: "test" } });
  });
});
