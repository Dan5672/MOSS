import { describe, expect, it } from "vitest";
import { chainAuditEntry, GENESIS_HASH, verifyAuditChain, type AuditEntryInput } from "./audit.js";
import { decryptSecret, encryptSecret, generateMasterKey, parseMasterKey, rewrapDataKey } from "./crypto.js";
import { redactSecrets } from "./redact.js";

describe("envelope encryption", () => {
  const key = generateMasterKey();

  it("round-trips a secret", () => {
    const enc = encryptSecret(key, "s1", "hunter2-🔑");
    expect(enc.ciphertext).not.toContain("hunter2");
    expect(decryptSecret(key, "s1", enc)).toBe("hunter2-🔑");
  });

  it("fails with the wrong master key", () => {
    const enc = encryptSecret(key, "s1", "hunter2");
    expect(() => decryptSecret(generateMasterKey(), "s1", enc)).toThrow();
  });

  it("binds ciphertext to its secret id", () => {
    const enc = encryptSecret(key, "s1", "hunter2");
    expect(() => decryptSecret(key, "s2", enc)).toThrow();
  });

  it("detects tampering", () => {
    const enc = encryptSecret(key, "s1", "hunter2");
    const raw = Buffer.from(enc.ciphertext, "base64");
    raw[raw.length - 1]! ^= 1;
    expect(() => decryptSecret(key, "s1", { ...enc, ciphertext: raw.toString("base64") })).toThrow();
  });

  it("rewraps data keys for master key rotation", () => {
    const enc = encryptSecret(key, "s1", "hunter2");
    const newKey = generateMasterKey();
    const rewrapped = { ...enc, wrappedDataKey: rewrapDataKey(key, newKey, "s1", enc.wrappedDataKey) };
    expect(decryptSecret(newKey, "s1", rewrapped)).toBe("hunter2");
  });

  it("parses hex, base64 and raw master key files", () => {
    expect(parseMasterKey(Buffer.from(key.toString("hex") + "\n")).equals(key)).toBe(true);
    expect(parseMasterKey(Buffer.from(key.toString("base64"))).equals(key)).toBe(true);
    expect(() => parseMasterKey(Buffer.from("too-short"))).toThrow();
  });
});

describe("redactSecrets", () => {
  it("removes raw and encoded secret values", () => {
    const secret = "p@ss w0rd!";
    const out = redactSecrets(
      `login ok as admin:${secret} auth=${Buffer.from(secret).toString("base64")} url=${encodeURIComponent(secret)}`,
      [secret],
    );
    expect(out).not.toContain(secret);
    expect(out).toBe("login ok as admin:[REDACTED] auth=[REDACTED] url=[REDACTED]");
  });
});

describe("audit chain", () => {
  const entry = (action: string, i: number): AuditEntryInput => ({
    orgId: "org",
    actorType: "agent",
    actorId: "a1",
    action,
    targetType: null,
    targetId: null,
    details: { i },
    createdAt: new Date(Date.UTC(2026, 9, 4, 0, 0, i)),
  });

  function build(n: number) {
    const chain = [];
    let prev = GENESIS_HASH;
    for (let i = 0; i < n; i++) {
      const e = chainAuditEntry(prev, entry(`tool.call.${i}`, i));
      chain.push(e);
      prev = e.hash;
    }
    return chain;
  }

  it("verifies an intact chain", () => {
    expect(verifyAuditChain(build(5))).toBe(-1);
  });

  it("detects edited and deleted entries", () => {
    const edited = build(5);
    edited[2] = { ...edited[2]!, details: { i: 99 } };
    expect(verifyAuditChain(edited)).toBe(2);

    const deleted = build(5);
    deleted.splice(1, 1);
    expect(verifyAuditChain(deleted)).toBe(1);
  });
});
