import { CHAT_NAMES, CHAT_TOKEN_SECRET, listChatLinks, loadChatModule, type ChatPlatform } from "@moss/core";
import { secrets } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { CheckboxField, SelectField, TextField } from "@/components/field";
import { NoPermission, PageHeader, timeAgo } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { saveChatSettingsAction, saveChatTokenAction, setChatEnabledAction, unlinkChatAction } from "./actions";

const SETUP: Record<ChatPlatform, React.ReactNode> = {
  telegram: (
    <ol className="grid list-decimal gap-1 pl-5">
      <li>
        In Telegram, message <strong>@BotFather</strong> and send <code>/newbot</code>. Pick a name, such as &quot;Our MOSS&quot;.
      </li>
      <li>BotFather replies with the bot&apos;s token (123456789:AA…). Paste it below.</li>
      <li>Switch the integration on. Then each person connects their own Telegram in Settings → General.</li>
    </ol>
  ),
  discord: (
    <ol className="grid list-decimal gap-1 pl-5">
      <li>
        In the Discord Developer Portal, create an application, open <strong>Bot</strong>, and Reset Token. Paste the token below.
      </li>
      <li>
        Under <strong>Installation</strong>, allow <strong>User Install</strong> (so people can message the bot directly), or invite the bot to a server you&apos;re
        in.
      </li>
      <li>Switch the integration on. Then each person connects their own Discord in Settings → General.</li>
    </ol>
  ),
};

/** A chat app's settings: the bot token, what MOSS sends, and who has connected. */
export async function ChatIntegrationPage({ platform }: { platform: ChatPlatform }) {
  const user = await requireUser();
  if (!user.permissions.has("integrations.manage")) return <NoPermission />;
  const name = CHAT_NAMES[platform];
  const [{ enabled, config: c }, token, links] = await Promise.all([
    loadChatModule(db(), user.orgId, platform),
    db().select({ updatedAt: secrets.updatedAt }).from(secrets).where(and(eq(secrets.orgId, user.orgId), eq(secrets.name, CHAT_TOKEN_SECRET[platform]))),
    listChatLinks(db(), user.orgId),
  ]);
  const mine = links.filter((l) => l.platform === platform);

  return (
    <>
      <PageHeader
        title={name}
        description={`Alerts on your phone, Approve and Reject buttons for changes, and your agents to talk to, in ${name}.`}
        trail={[
          { href: "/settings", label: "Settings" },
          { href: "/settings/integrations", label: "Integrations" },
        ]}
        actions={
          <ActionForm
            action={setChatEnabledAction.bind(null, platform, !enabled)}
            submitLabel={enabled ? "Switch integration off" : "Switch integration on"}
            submitVariant={enabled ? "outline" : "default"}
            confirm={enabled ? `Switch ${name} off? The bot stops, and nobody gets messages there.` : undefined}
          />
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card id="bot">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              The bot <Badge variant={token.length ? "default" : "outline"}>{token.length ? "Token saved" : "No token"}</Badge>
            </CardTitle>
            <CardDescription>
              Your own bot, so messages stay between you and it. The token is stored encrypted; only MOSS&apos;s chat bridge gets it, while this integration is on.
              Nothing has to reach MOSS from the internet.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            {SETUP[platform]}
            <ActionForm action={saveChatTokenAction.bind(null, platform)} submitLabel="Save token" resetOnSuccess>
              <TextField label="Bot token" name="token" type="password" autoComplete="off" placeholder={token.length ? "Saved. Paste a new one to replace it." : undefined} required />
            </ActionForm>
          </CardContent>
        </Card>

        <Card id="messages">
          <CardHeader>
            <CardTitle>What MOSS sends</CardTitle>
            <CardDescription>Each connected person gets their own MOSS notifications, as they would in MOSS, filtered by these.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={saveChatSettingsAction.bind(null, platform)} submitLabel="Save">
              <div className="grid gap-3 sm:grid-cols-2">
                <CheckboxField label="Incidents" name="incidents" defaultChecked={c.incidents} />
                <SelectField
                  label="From priority"
                  name="minPriority"
                  defaultValue={c.minPriority}
                  options={["P1", "P2", "P3", "P4"].map((p) => ({ value: p, label: `${p} and up` }))}
                />
              </div>
              <CheckboxField label="Monitors degraded and back up" name="monitors" defaultChecked={c.monitors} />
              <CheckboxField label="Changes waiting for approval" name="changes" defaultChecked={c.changes} />
              <CheckboxField
                label="Approve and Reject buttons"
                name="approvals"
                defaultChecked={c.approvals}
                hint="For people who may approve changes. Emergency, high-risk and dangerous changes, and agents' access requests, are still approved in MOSS."
              />
              <CheckboxField label="Mentions, comments and agents' replies" name="messages" defaultChecked={c.messages} />
              <TextField label="MOSS's address (for links)" name="mossUrl" defaultValue={c.mossUrl} placeholder="https://10.0.0.213" hint="As people's phones reach MOSS. Leave empty for no links." />
            </ActionForm>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Connected people</CardTitle>
            <CardDescription>People connect their own {name} account in Settings → General, by sending the bot a one-time code. Messages from anyone else are ignored.</CardDescription>
          </CardHeader>
          <CardContent>
            {mine.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody yet.</p>
            ) : (
              <ul className="grid gap-2 text-sm" aria-label={`Connected to ${name}`}>
                {mine.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-3">
                    <span className="font-medium">{l.userName}</span>
                    {l.username && <span className="font-mono text-muted-foreground">@{l.username}</span>}
                    <span className="flex-1 font-mono text-xs text-muted-foreground">since {timeAgo(l.createdAt)}</span>
                    <ActionForm action={unlinkChatAction.bind(null, l.id)} submitLabel="Disconnect" submitVariant="outline" inline confirm={`Disconnect ${l.userName}'s ${name}?`} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
