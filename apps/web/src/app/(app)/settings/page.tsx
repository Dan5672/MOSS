import { CHAT_NAMES, CHAT_PLATFORMS, getSetting, listChatLinks, loadChatModule, totpUri, type SettingKey } from "@moss/core";
import { cookies } from "next/headers";
import QRCode from "qrcode";
import { ActionForm } from "@/components/action-form";
import { SelectField, TextField } from "@/components/field";
import { PageHeader } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { confirmTotpAction, disableTotpAction, saveApprovalRulesAction, setMotionAction, setSetupChecklistHiddenAction, startTotpAction, toggleSettingAction } from "./actions";
import { ConnectChat } from "./chat-connect";
import { weakens } from "./hardening";
import { HttpsCard } from "./https-card";
import { SignInAccounts } from "./sign-in-accounts";
import { unlinkMyChatAction } from "./integrations/chat/actions";

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
    key: "agents.allow_internet",
    title: "Agents may reach the internet",
    description:
      "Lets agents check public addresses (ping, TCP, HTTP, TLS) and look up names outside your network. Turn it off so an agent misled by something it read can't send your data out. Monitors aren't affected.",
    permission: "settings.manage",
  },
  {
    key: "tools.pin_hosts",
    title: "Remember device keys",
    description:
      "The first time MOSS sends a device a credential, it remembers the device's certificate or SSH host key. If that changes, the credential isn't sent until you trust the new one in Settings, Security.",
    permission: "settings.manage",
  },
  {
    key: "tools.verify_tls",
    title: "Require trusted certificates",
    description:
      "Credentials only go to devices whose certificate is signed by a trusted authority and names the device's IP address. A renewed certificate is then accepted without asking. Leave it off if your devices use self-signed certificates.",
    permission: "settings.manage",
  },
  {
    key: "changes.approval_totp",
    title: "Two-factor code to approve",
    description: "Approving a change asks for the approver's two-factor code, so a stolen session or chat account can't approve. The chat apps' Approve button goes away.",
    permission: "settings.manage",
  },
  {
    key: "knowledge.agent_drafts",
    title: "Agents write wiki drafts",
    description: "What agents write in the wiki waits for a person to publish it before other agents read it, so a note one agent was tricked into writing can't mislead the rest.",
    permission: "settings.manage",
  },
  {
    key: "agents.credentials_need_manager",
    title: "Credentials only for work credential managers start",
    description:
      "Agent work someone started (a chat, a run, a schedule they set) may only use stored credentials if that person can manage credentials. Stops a smaller role reaching devices through an agent.",
    permission: "settings.manage",
  },
  {
    key: "auth.sso_require_totp",
    title: "Two-factor for Microsoft and Google sign-in too",
    description: "The password policy's two-factor rule applies to people who sign in with Microsoft or Google: they set up a MOSS code and enter it after signing in.",
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

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const user = await requireUser({ unblocks: "enrol_totp" });
  const q = await searchParams;
  const values = Object.fromEntries(await Promise.all(TOGGLES.map(async (t) => [t.key, await getSetting(db(), user.orgId, t.key)] as const)));
  const [chatApprovals, emergencyTools] = await Promise.all([getSetting(db(), user.orgId, "changes.chat_approvals"), getSetting(db(), user.orgId, "changes.emergency_tools")]);
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
      <div className="grid gap-6 lg:grid-cols-2">
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
                {user.hasPassword && <TextField label="Confirm your password" name="password" type="password" autoComplete="current-password" required />}
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
