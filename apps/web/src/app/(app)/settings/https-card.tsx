import { headers } from "next/headers";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { httpsInfo } from "@/server/https-info";

/** Whether this connection is HTTPS, and how each device trusts MOSS's own certificate authority. */
export async function HttpsCard() {
  const [info, h] = await Promise.all([httpsInfo(), headers()]);
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
      {info.mode === "internal" && (
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
