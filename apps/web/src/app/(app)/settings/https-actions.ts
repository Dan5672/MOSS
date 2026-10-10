"use server";

import { CertificateError, checkCertificate, httpsHostList, setSetting, writeAudit, type UploadedCertificateInfo } from "@moss/core";
import { revalidatePath } from "next/cache";
import { act, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";
import { switchCertificate } from "@/server/tls-store";

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
