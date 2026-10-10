import { getSetting, totpUri, type SettingKey } from "@moss/core";
import { cookies } from "next/headers";
import QRCode from "qrcode";
import { ActionForm } from "@/components/action-form";
import { SelectField, TextField } from "@/components/field";
import { PageHeader } from "@/components/page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { confirmTotpAction, disableTotpAction, setMotionAction, setSetupChecklistHiddenAction, startTotpAction, toggleSettingAction } from "./actions";
import { HttpsCard } from "./https-card";
import { SettingsTabs } from "./tabs";

export const metadata = { title: "Settings" };

const TOGGLES: { key: SettingKey; title: string; description: string; danger?: boolean; permission: "killswitch.use" | "settings.manage" }[] = [
  {
    key: "agents.kill_switch",
    title: "Kill switch",
    description: "Stop every agent immediately. Running agents halt before their next step and nothing new starts.",
    danger: true,
    permission: "killswitch.use",
  },
  {
    key: "changes.allow_emergency",
    title: "Allow emergency changes",
    description: "Let agents make urgent changes without waiting for approval. Each one is flagged for review afterwards.",
    permission: "settings.manage",
  },
  {
    key: "changes.require_separate_approver",
    title: "Require a separate approver",
    description: "Nobody can approve a change they requested themselves.",
    permission: "settings.manage",
  },
  {
    key: "tools.allow_vulners",
    title: "Allow CVE lookups",
    description: "Let agents look up known vulnerabilities for the software versions they find (vuln_scan's cve profile). It sends service names and versions to vulners.com.",
    permission: "settings.manage",
  },
  {
    key: "tools.allow_dangerous",
    title: "Allow dangerous tools",
    description: "Permit tools marked dangerous (for example factory resets), still only through approved changes.",
    danger: true,
    permission: "settings.manage",
  },
];

export default async function SettingsPage() {
  const user = await requireUser();
  const values = Object.fromEntries(await Promise.all(TOGGLES.map(async (t) => [t.key, await getSetting(db(), user.orgId, t.key)] as const)));
  const pendingSecret = (await cookies()).get("moss_totp_pending")?.value;
  const qr = pendingSecret ? await QRCode.toDataURL(totpUri(pendingSecret, user.email), { margin: 1, width: 200 }) : null;

  return (
    <>
      <PageHeader title="Settings" />
      <SettingsTabs current="/settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <HttpsCard />
        <Card>
          <CardHeader>
            <CardTitle>Display</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={setMotionAction} submitLabel="Save">
              <SelectField
                label="Motion"
                name="motion"
                defaultValue={user.motion}
                hint="Animations such as the Basement, blinking mascots and the alarm. Follow system turns them off when your device asks for less motion."
                options={[
                  { value: "system", label: "Follow system" },
                  { value: "on", label: "Always on" },
                  { value: "off", label: "Always off" },
                ]}
              />
            </ActionForm>
            {user.preferences.hideSetupChecklist && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t-2 pt-4 text-sm">
                <span>The dashboard&apos;s Getting started checklist is dismissed.</span>
                <ActionForm action={setSetupChecklistHiddenAction.bind(null, false)} submitLabel="Show it again" submitVariant="outline" inline />
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Safety</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {TOGGLES.map((t) => {
              const on = !!values[t.key];
              const allowed = user.permissions.has(t.permission);
              return (
                <div key={t.key} className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
                  <div>
                    <div className="font-medium">
                      {t.title} <span className={on ? (t.danger ? "text-alarm" : "text-phosphor") : "text-muted-foreground"}>· {on ? "on" : "off"}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{t.description}</p>
                  </div>
                  {allowed && (
                    <ActionForm
                      action={toggleSettingAction.bind(null, t.key, !on)}
                      submitLabel={on ? "Turn off" : "Turn on"}
                      submitVariant={!on && t.danger ? "destructive" : "outline"}
                      confirm={!on && t.key === "tools.allow_dangerous" ? "Allow dangerous tools? They still need approved changes." : undefined}
                    />
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Two-factor authentication</CardTitle>
            <CardDescription>Ask for a code from an authenticator app when you sign in.</CardDescription>
          </CardHeader>
          <CardContent>
            {user.totpEnabled ? (
              <ActionForm action={disableTotpAction} submitLabel="Turn off two-factor" submitVariant="outline">
                <p className="text-sm">Two-factor authentication is on for {user.email}.</p>
                <TextField label="Confirm your password" name="password" type="password" autoComplete="current-password" required />
              </ActionForm>
            ) : qr ? (
              <ActionForm action={confirmTotpAction} submitLabel="Confirm">
                <p className="text-sm">Scan this with your authenticator app, then enter the 6-digit code it shows.</p>
                {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
                <img src={qr} alt="QR code for your authenticator app" width={200} height={200} className="rounded border bg-white" />
                <details className="text-xs text-muted-foreground">
                  <summary>Can&apos;t scan? Enter this key instead</summary>
                  <code className="break-all">{pendingSecret}</code>
                </details>
                <TextField label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
              </ActionForm>
            ) : (
              <ActionForm action={startTotpAction} submitLabel="Set up two-factor" />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
