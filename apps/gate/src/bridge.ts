// The chat bridge's bot tokens. The bridge (Telegram and Discord) holds them in memory to talk to those services;
// the gate decrypts each only while its integration is switched on, and audits it when what it hands out changes.
import { CHAT_PLATFORMS, CHAT_TOKEN_SECRET, chatLicensed, decryptSecret, SLACK_APP_TOKEN_SECRET, writeAudit, type ChatPlatform } from "@moss/core";
import { modules, secrets, type Database } from "@moss/db";
import { and, eq, inArray } from "drizzle-orm";

export interface BridgeCredential {
  orgId: string;
  platform: ChatPlatform;
  token: string;
  /** Slack: the app-level token for its Socket Mode connection. */
  appToken?: string;
}

export function createBridgeCredentials(deps: { db: Database; masterKey: Buffer }) {
  let handedOut = "";
  return async (): Promise<BridgeCredential[]> => {
    const on = await deps.db.select({ orgId: modules.orgId, key: modules.key }).from(modules).where(and(inArray(modules.key, [...CHAT_PLATFORMS]), eq(modules.enabled, true)));
    const out: (BridgeCredential & { secretId: string; rotated: string })[] = [];
    for (const m of on) {
      const platform = m.key as ChatPlatform;
      // Slack is business: no licence, no bot.
      if (!(await chatLicensed(deps.db, m.orgId, platform))) continue;
      const [s] = await deps.db.select().from(secrets).where(and(eq(secrets.orgId, m.orgId), eq(secrets.name, CHAT_TOKEN_SECRET[platform])));
      if (!s) continue;
      let appToken: string | undefined;
      let rotated = String(s.updatedAt?.getTime() ?? 0);
      if (platform === "slack") {
        const [a] = await deps.db.select().from(secrets).where(and(eq(secrets.orgId, m.orgId), eq(secrets.name, SLACK_APP_TOKEN_SECRET)));
        if (!a) continue;
        appToken = decryptSecret(deps.masterKey, a.id, a);
        rotated += `/${a.updatedAt?.getTime() ?? 0}`;
      }
      out.push({ orgId: m.orgId, platform, token: decryptSecret(deps.masterKey, s.id, s), ...(appToken ? { appToken } : {}), secretId: s.id, rotated });
    }
    const fingerprint = out.map((c) => `${c.orgId}:${c.platform}:${c.rotated}`).sort().join("|");
    if (fingerprint !== handedOut) {
      handedOut = fingerprint;
      for (const c of out) {
        await writeAudit(deps.db, { orgId: c.orgId, actorType: "system", action: "secret.use", targetType: "secret", targetId: c.secretId, details: { by: "chat bridge", platform: c.platform } });
      }
    }
    return out.map(({ orgId, platform, token, appToken }) => ({ orgId, platform, token, ...(appToken ? { appToken } : {}) }));
  };
}
