// Checking a certificate someone uploads for MOSS's HTTPS (Settings → HTTPS) before it's used: the key
// matches, it's in date, the chain hangs together, and it covers the names MOSS answers to. Problems that
// would break HTTPS are errors; things that only some devices would mind are warnings.
import { createPrivateKey, X509Certificate, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { rootCertificates } from "node:tls";

export interface CertificateCheck {
  /** Who it's for, who issued it, and when it runs out. */
  subject: string;
  issuer: string;
  notAfter: Date;
  fingerprint: string;
  /** Which of MOSS's host names it covers, and which it doesn't. */
  covers: string[];
  missing: string[];
  warnings: string[];
  /** The chain as uploaded (leaf first), and the key, both as PEM. */
  certPem: string;
  keyPem: string;
}

export class CertificateError extends Error {}

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Splits the comma-separated MOSS_HTTPS_HOSTS into names and addresses. */
export function httpsHostList(hosts: string): string[] {
  return hosts
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter((h) => h && h !== "localhost");
}

export function checkCertificate(certText: string, keyText: string, hosts: string[], now = new Date()): CertificateCheck {
  const pems = certText.match(PEM_CERT) ?? [];
  if (!pems.length) throw new CertificateError("That isn't a PEM certificate (it should start with -----BEGIN CERTIFICATE-----).");
  let chain: X509Certificate[];
  try {
    chain = pems.map((p) => new X509Certificate(p));
  } catch {
    throw new CertificateError("One of the certificates couldn't be read.");
  }
  // The key may come in a file with certificates too (e.g. converted from a .pfx).
  const keyBlock = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]+?-----END \1PRIVATE KEY-----/.exec(keyText)?.[0] ?? keyText;
  if (/ENCRYPTED/.test(keyBlock)) throw new CertificateError("The private key is protected by a passphrase. Upload it without one.");
  let key: KeyObject;
  try {
    key = createPrivateKey(keyBlock);
  } catch {
    throw new CertificateError("The private key couldn't be read. It should be PEM (-----BEGIN PRIVATE KEY----- or similar).");
  }
  const leaf = chain[0]!;
  if (!leaf.checkPrivateKey(key)) throw new CertificateError("The private key doesn't belong to this certificate (the first one in the file).");
  if (new Date(leaf.validTo) <= now) throw new CertificateError(`The certificate expired on ${new Date(leaf.validTo).toDateString()}.`);
  if (new Date(leaf.validFrom) > now) throw new CertificateError(`The certificate isn't valid until ${new Date(leaf.validFrom).toDateString()}.`);
  if (leaf.ca) throw new CertificateError("The first certificate is a certificate authority, not a server certificate. Put the server's certificate first.");

  const warnings: string[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    if (!chain[i]!.checkIssued(chain[i + 1]!) || !chain[i]!.verify(chain[i + 1]!.publicKey)) {
      throw new CertificateError(`The chain is out of order: certificate ${i + 1} wasn't issued by certificate ${i + 2}. Put the server's certificate first, then each issuer.`);
    }
  }
  const top = chain[chain.length - 1]!;
  const selfSigned = top.checkIssued(top);
  if (!selfSigned && !rootCertificates.some((r) => top.checkIssued(new X509Certificate(r)))) {
    warnings.push(
      chain.length === 1
        ? "Only the server's certificate was uploaded. If it comes from a public authority, include the intermediate certificates too (the full chain), or some devices won't trust it."
        : "The chain doesn't end at a well-known authority. That's fine for your own private CA, as long as your devices trust it.",
    );
  }
  if (chain.length === 1 && selfSigned) warnings.push("It's self-signed, so every device will warn about it unless you trust it on each one.");

  const covers: string[] = [];
  const missing: string[] = [];
  for (const h of hosts) (isIP(h) ? leaf.checkIP(h) : leaf.checkHost(h)) ? covers.push(h) : missing.push(h);
  if (hosts.length && !covers.length) {
    throw new CertificateError(`It doesn't cover any of the names MOSS answers to (${hosts.join(", ")}).`);
  }
  if (missing.length) warnings.push(`It doesn't cover ${missing.join(", ")}: opening MOSS by ${missing.length === 1 ? "that name" : "those names"} will show a warning.`);
  const days = Math.floor((new Date(leaf.validTo).getTime() - now.getTime()) / 86_400_000);
  if (days < 30) warnings.push(`It runs out in ${days} days.`);

  return {
    subject: leaf.subject.replace(/\n/g, ", "),
    issuer: leaf.issuer.replace(/\n/g, ", "),
    notAfter: new Date(leaf.validTo),
    fingerprint: leaf.fingerprint256,
    covers,
    missing,
    warnings,
    certPem: chain.map((c) => c.toString().trim()).join("\n") + "\n",
    keyPem: key.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** What MOSS remembers about the uploaded certificate (the setting https.certificate), for reminders. */
export interface UploadedCertificateInfo {
  subject: string;
  notAfter: string;
  fingerprint: string;
  /** Reminders already sent (days before expiry). */
  reminded?: number[];
}

/** Which reminder (30 or 7 days) is due now, if any. */
export function certificateReminderDue(info: UploadedCertificateInfo, now = new Date()): number | null {
  const days = (new Date(info.notAfter).getTime() - now.getTime()) / 86_400_000;
  for (const at of [7, 30]) if (days <= at && !(info.reminded ?? []).includes(at)) return at;
  return null;
}
