import { CHAT_NAMES, CHAT_PLATFORMS, getSetting, listChatLinks, loadChatModule, serverTimeZone, totpUri, type SettingKey } from "@moss/core";
import { cookies } from "next/headers";
import QRCode from "qrcode";
import { ActionForm } from "@/components/action-form";
import { SelectField, TextField } from "@/components/field";
import { PageHeader } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { confirmTotpAction, disableTotpAction, saveApprovalRulesAction, saveTimeZoneAction, setMotionAction, setSetupChecklistHiddenAction, startTotpAction, toggleSettingAction } from "./actions";
import { ConnectChat } from "./chat-connect";
import { weakens } from "./hardening";
import { TOGGLES } from "./toggles";
import { HttpsCard } from "./https-card";
import { SignInAccounts } from "./sign-in-accounts";
import { unlinkMyChatAction } from "./integrations/chat/actions";
import { Masonry } from "@/components/masonry";

export const metadata = { title: "Settings" };


export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const user = await requireUser({ unblocks: "enrol_totp" });
  const q = await searchParams;
  const values = Object.fromEntries(await Promise.all(TOGGLES.map(async (t) => [t.key, await getSetting(db(), user.orgId, t.key)] as const)));
  const [chatApprovals, emergencyTools, timeZone] = await Promise.all([
    getSetting(db(), user.orgId, "changes.chat_approvals"),
    getSetting(db(), user.orgId, "changes.emergency_tools"),
    getSetting(db(), user.orgId, "general.time_zone"),
  ]);
  const pendingSecret = (await cookies()).get("moss_totp_pending")?.value;
  const qr = pendingSecret ? await QRCode.toDataURL(totpUri(pendingSecret, user.email), { margin: 1, width: 200 }) : null;
  const [chatApps, myLinks] = await Promise.all([
    Promise.all(CHAT_PLATFORMS.map(async (p) => ({ p, on: (await loadChatModule(db(), user.orgId, p)).enabled }))),
    listChatLinks(db(), user.orgId, user.id),
  ]);
  const chatOn = chatApps.filter((c) => c.on);

  return (
    <>
      <PageHeader title="Settings" />
      {user.blocker === "enrol_totp" && (
        <Alert className="mb-6" role="alert">
          <AlertTitle>Set up two-factor sign-in to carry on</AlertTitle>
          <AlertDescription>The password policy requires it for your account. Use the Two-factor authentication card below; it takes a minute with an authenticator app.</AlertDescription>
        </Alert>
      )}
      <Masonry gap={24} className="lg:grid-cols-2">
        <HttpsCard orgId={user.orgId} canManage={user.permissions.has("settings.manage")} />
        <SignInAccounts user={user} linked={typeof q.sso_linked === "string" ? q.sso_linked : undefined} error={typeof q.sso_error === "string" ? q.sso_error.slice(0, 300) : undefined} />
        {(chatOn.length > 0 || myLinks.length > 0) && (
          <Card id="chat-apps">
            <CardHeader>
              <CardTitle>Telegram and Discord</CardTitle>
              <CardDescription>Get your MOSS notifications on your phone, approve changes with a tap, and talk to your agents.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm">
              {myLinks.map((l) => (
                <div key={l.id} className="flex flex-wrap items-center gap-3">
                  <span>
                    Connected to {CHAT_NAMES[l.platform]}
                    {l.username ? <> as <span className="font-mono">@{l.username}</span></> : null}.
                  </span>
                  <ActionForm action={unlinkMyChatAction.bind(null, l.id)} submitLabel="Disconnect" submitVariant="outline" inline />
                </div>
              ))}
              {chatOn
                .filter((c) => !myLinks.some((l) => l.platform === c.p))
                .map((c) => (
                  <ConnectChat key={c.p} platform={c.p} name={CHAT_NAMES[c.p]} />
                ))}
            </CardContent>
          </Card>
        )}
        <Card id="display">
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
        <Card id="safety">
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
                      inline
                    >
                      {/* Weakening a protection asks for the person's code (see ./hardening.ts). */}
                      {user.totpEnabled && weakens(t.key, !on) && <TextField label="Your two-factor code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required />}
                    </ActionForm>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>

        {user.permissions.has("settings.manage") && (
          <Card id="time-zone">
            <CardHeader>
              <CardTitle>Time zone</CardTitle>
              <CardDescription>The times MOSS shows everywhere, when &quot;today&quot; and &quot;this month&quot; start, and when recurring tasks run.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={saveTimeZoneAction} submitLabel="Save">
                <SelectField
                  label="Time zone"
                  name="timeZone"
                  defaultValue={timeZone}
                  options={[{ value: "", label: `This computer's (${serverTimeZone()})` }, ...Intl.supportedValuesOf("timeZone").map((z) => ({ value: z, label: z.replaceAll("_", " ") }))]}
                  hint="This computer's is the one MOSS runs on (TZ in deploy/.env, set from the host when MOSS was installed)."
                />
              </ActionForm>
            </CardContent>
          </Card>
        )}

        {user.permissions.has("settings.manage") && (
          <Card id="approvals">
            <CardHeader>
              <CardTitle>Approval rules</CardTitle>
              <CardDescription>What may be approved from a chat app, and what emergency changes may do. See the hardening guide (docs/hardening.md).</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={saveApprovalRulesAction} submitLabel="Save">
                <SelectField
                  label="Approve from Telegram, Discord and Slack"
                  name="chatApprovals"
                  defaultValue={chatApprovals}
                  options={[
                    { value: "standard", label: "Anything but high-risk changes" },
                    { value: "low_risk", label: "Low-risk changes only" },
                    { value: "off", label: "Nothing: approve in MOSS" },
                  ]}
                  hint="Emergency changes, access requests, dangerous tools and anything that can take a device offline are always approved in MOSS."
                />
                <TextField
                  label="Tools emergency changes may use"
                  name="emergencyTools"
                  defaultValue={emergencyTools.join(", ")}
                  hint="Tool names separated by commas, for example service_restart, container_restart. Empty: any tool. Only matters while emergency changes are allowed."
                />
                {user.totpEnabled && (
                  <TextField
                    label="Your two-factor code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    hint="Needed when you allow more from chat or more tools in emergencies."
                  />
                )}
              </ActionForm>
            </CardContent>
          </Card>
        )}

        <Card id="two-factor">
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
                {user.hasPassword && <TextField label="Confirm your password" name="password" type="password" autoComplete="current-password" required />}
              </ActionForm>
            ) : (
              <ActionForm action={startTotpAction} submitLabel="Set up two-factor" />
            )}
          </CardContent>
        </Card>
      </Masonry>
    </>
  );
}
