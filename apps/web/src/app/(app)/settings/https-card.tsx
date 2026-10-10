import { getSetting } from "@moss/core";
import { headers } from "next/headers";
import { ActionForm } from "@/components/action-form";
import { TextField } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/server/db";
import { httpsInfo } from "@/server/https-info";
import { activeCertificate } from "@/server/tls-store";
import { switchToOwnCaAction, uploadCertificateAction } from "./https-actions";

/**
 * Whether this connection is HTTPS, how each device trusts MOSS's own certificate authority, and (for
 * people who manage settings) uploading a certificate of your own instead.
 */
export async function HttpsCard({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const [info, h, active, uploaded] = await Promise.all([
    httpsInfo(),
    headers(),
    activeCertificate(),
    getSetting(db(), orgId, "https.certificate") as Promise<{ subject?: string; notAfter?: string; fingerprint?: string }>,
  ]);
  const secure = (h.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() === "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";

  return (
    <Card id="https" className="scroll-mt-6 lg:col-span-2">
      <CardHeader>
        <CardTitle>HTTPS</CardTitle>
        <CardDescription>
          {secure ? (
            <>This connection is encrypted (https://{host}).</>
          ) : info.mode ? (
            <>HTTPS is on, but this page was opened without it. Use https://{host.replace(/:\d+$/, "")} (with MOSS&apos;s HTTPS port) instead.</>
          ) : (
            <>
              HTTPS is off: MOSS only answers on this machine. To use it from other devices, switch HTTPS on in <code>deploy/.env</code> (
              <code>COMPOSE_PROFILES=https</code>, see <code>.env.example</code>) and restart MOSS.
            </>
          )}
        </CardDescription>
      </CardHeader>
      {info.mode === "internal" && active === "uploaded" && (
        <CardContent className="grid gap-3 text-sm">
          <p>MOSS uses a certificate you uploaded{uploaded.subject ? <> for <strong>{uploaded.subject}</strong></> : null}.</p>
          {uploaded.notAfter && (
            <p>
              Valid until {new Date(uploaded.notAfter).toLocaleDateString()}. Moss reminds everyone in #general 30 and 7 days before it runs out.
            </p>
          )}
          {uploaded.fingerprint && (
            <code className="break-all bg-muted p-2 font-mono text-xs" aria-label="Certificate fingerprint">
              {uploaded.fingerprint}
            </code>
          )}
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <UploadDialog label="Replace certificate" />
              <ActionForm
                action={switchToOwnCaAction}
                submitLabel="Use MOSS's own certificate"
                submitVariant="outline"
                confirm="Switch back to MOSS's own certificate authority? Devices that don't trust it will show a warning."
                inline
              />
            </div>
          )}
        </CardContent>
      )}
      {info.mode === "internal" && active !== "uploaded" && (
        <CardContent className="grid gap-3 text-sm">
          <p>
            MOSS uses its own certificate authority, so nothing has to be bought or exposed to the internet. Each device trusts it once:{" "}
            <a href="/moss-ca.crt" className="underline underline-offset-2">
              download MOSS&apos;s certificate
            </a>
            , then:
          </p>
          <ul className="grid list-disc gap-1 pl-5">
            <li>
              <strong>Windows:</strong> open it, Install Certificate, Local Machine, &quot;Place all certificates in the following store&quot;, Trusted Root
              Certification Authorities.
            </li>
            <li>
              <strong>macOS:</strong> open it in Keychain Access (System keychain), then set it to Always Trust.
            </li>
            <li>
              <strong>iPhone and iPad:</strong> open the download, install the profile in Settings, then switch it on in General, About, Certificate Trust
              Settings.
            </li>
            <li>
              <strong>Android:</strong> Settings, Security, Encryption &amp; credentials, Install a certificate, CA certificate.
            </li>
            <li>
              <strong>Home Assistant:</strong> nothing to install. When you add MOSS, the integration shows this fingerprint; check it matches and it
              trusts MOSS from then on.
            </li>
          </ul>
          {info.ca ? (
            <p className="grid gap-1">
              <span>Before trusting it, check the fingerprint matches (SHA-256):</span>
              <code className="break-all bg-muted p-2 font-mono text-xs" aria-label="Certificate fingerprint">
                {info.ca.fingerprint}
              </code>
              <span className="text-xs text-muted-foreground">Valid until {new Date(info.ca.expires).toLocaleDateString()}.</span>
            </p>
          ) : (
            <p className="text-muted-foreground">The certificate is created the first time HTTPS starts.</p>
          )}
          {canManage && active && (
            <div className="grid gap-2 border-t pt-3">
              <p>
                Have a certificate already (from Let&apos;s Encrypt, Tailscale or your company&apos;s CA)? Upload it and devices that trust its
                issuer need nothing installed.
              </p>
              <div>
                <UploadDialog label="Upload a certificate" />
              </div>
            </div>
          )}
        </CardContent>
      )}
      {info.mode === "files" && (
        <CardContent className="text-sm">
          MOSS uses your own certificate from <code>deploy/certs</code>. Replace <code>cert.pem</code> and <code>key.pem</code> before they expire, then restart
          the https service.
        </CardContent>
      )}
    </Card>
  );
}

function UploadDialog({ label }: { label: string }) {
  return (
    <FormDialog
      label={label}
      variant="outline"
      title="Use your own certificate"
      description="PEM files. It's checked first: the key must match, it must be in date and cover at least one of MOSS's names. The key stays on this machine, readable only by the web and HTTPS services."
    >
      <ActionForm action={uploadCertificateAction} submitLabel="Check and use">
        <TextField
          label="Certificate"
          name="certificate"
          type="file"
          accept=".pem,.crt,.cer,text/plain"
          required
          hint="The full chain: your server's certificate first, then the intermediates (fullchain.pem from Let's Encrypt)."
        />
        <TextField
          label="Private key"
          name="key"
          type="file"
          accept=".pem,.key,text/plain"
          required
          hint={
            <>
              Without a passphrase. Have a .pfx? Convert it with <code>openssl pkcs12 -in cert.pfx -nodes -out both.pem</code> and upload the
              same file for both.
            </>
          }
        />
      </ActionForm>
    </FormDialog>
  );
}
