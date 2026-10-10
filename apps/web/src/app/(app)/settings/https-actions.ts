"use server";

import { CertificateError, checkCertificate, httpsHostList, setSetting, writeAudit, type UploadedCertificateInfo } from "@moss/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { act, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";
import { setLetsEncrypt, switchCertificate } from "@/server/tls-store";

const MAX_BYTES = 64 * 1024;

async function fileText(form: FormData, name: string, label: string): Promise<string> {
  const file = form.get(name);
  if (!(file instanceof File) || file.size === 0) throw new Error(`Choose the ${label} file.`);
  if (file.size > MAX_BYTES) throw new Error(`The ${label} file is too big for a PEM file.`);
  return file.text();
}

/** Checks an uploaded certificate and key, then switches HTTPS over to them. */
export async function uploadCertificateAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("settings.manage");
    const certText = await fileText(form, "certificate", "certificate");
    const keyText = await fileText(form, "key", "private key");
    let checked;
    try {
      checked = checkCertificate(certText, keyText, httpsHostList(process.env.MOSS_HTTPS_HOSTS ?? ""));
    } catch (err) {
      if (err instanceof CertificateError) throw new Error(err.message);
      throw err;
    }
    await switchCertificate(checked);
    const info: UploadedCertificateInfo = { subject: checked.subject, notAfter: checked.notAfter.toISOString(), fingerprint: checked.fingerprint, reminded: [] };
    await setSetting(db(), user.orgId, "https.certificate", { ...info });
    await writeAudit(db(), {
      orgId: user.orgId,
      actorType: "user",
      actorId: user.id,
      action: "https.certificate_uploaded",
      targetType: "setting",
      targetId: "https.certificate",
      details: { subject: checked.subject, issuer: checked.issuer, notAfter: info.notAfter, fingerprint: checked.fingerprint },
    });
    revalidatePath("/settings");
    return ["MOSS now uses your certificate.", ...checked.warnings].join(" ");
  });
}

/** Goes back to MOSS's own certificate authority. */
export async function switchToOwnCaAction(_: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("settings.manage");
    await switchCertificate("own_ca");
    await setSetting(db(), user.orgId, "https.certificate", {});
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "https.own_ca", targetType: "setting", targetId: "https.certificate", details: {} });
    revalidatePath("/settings");
    return "MOSS is back on its own certificate authority. The uploaded key has been deleted.";
  });
}

const leSchema = z.object({
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "The hostname must be a full public name, e.g. moss.example.com."),
  token: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{20,200}$/, "That doesn't look like a Cloudflare API token.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

/** Gets MOSS a trusted certificate from Let's Encrypt for a public name, through a Cloudflare DNS challenge. */
export async function useLetsEncryptAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("settings.manage");
    const parsed = leSchema.safeParse({ hostname: form.get("hostname") ?? "", token: form.get("token") ?? "" });
    if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);
    await setLetsEncrypt(parsed.data);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "https.letsencrypt", targetType: "setting", targetId: "https.letsencrypt", details: { hostname: parsed.data.hostname, newToken: !!parsed.data.token } });
    revalidatePath("/settings");
    return `MOSS is getting a certificate for ${parsed.data.hostname} from Let's Encrypt; it takes a minute or two. Point ${parsed.data.hostname} at MOSS's address (a DNS record, not proxied), then open https://${parsed.data.hostname}.`;
  });
}

/** Stops using Let's Encrypt and deletes the stored Cloudflare token. */
export async function stopLetsEncryptAction(_: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("settings.manage");
    await setLetsEncrypt(null);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "https.letsencrypt_off", targetType: "setting", targetId: "https.letsencrypt", details: {} });
    revalidatePath("/settings");
    return "Let's Encrypt is off, and the Cloudflare token has been deleted. MOSS's other addresses are unchanged.";
  });
}
