import {
  CHAT_NAMES,
  CHAT_PLAN,
  CHAT_PLATFORMS,
  getLicenceStatus,
  integrationAllowed,
  INTEGRATIONS,
  isModuleEnabled,
  listChatLinks,
  loadChatModule,
  loadHomeAssistant,
  loadIntegration,
  type ChatPlatform,
  type IntegrationDef,
} from "@moss/core";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { NoPermission, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { setSyslogEnabledAction } from "./actions";

export const metadata = { title: "Integrations" };

export default async function ModulesPage() {
  const user = await requireUser();
  if (!user.permissions.has("integrations.manage")) return <NoPermission />;
  const [ha, others, chats, links, licence, syslog] = await Promise.all([
    loadHomeAssistant(db(), user.orgId),
    Promise.all(INTEGRATIONS.map(async (def) => ({ def, it: await loadIntegration(db(), user.orgId, def) }))),
    Promise.all(CHAT_PLATFORMS.map(async (p) => ({ p, it: await loadChatModule(db(), user.orgId, p) }))),
    listChatLinks(db(), user.orgId),
    getLicenceStatus(db(), user.orgId),
    isModuleEnabled(db(), user.orgId, "syslog"),
  ]);
  const business = others.filter(({ def }) => def.plan === "business");
  const c = ha.config;
  const features = [
    c.alerts.enabled && "alerts",
    c.health.enabled && "health checks",
    c.notify.enabled && "phone notifications",
    c.sensors.enabled && "status sensors",
    c.inventory.enabled && "inventory sync",
    c.selfHeal.enabled && "internet self-heal",
    c.logReview.enabled && "log review",
  ].filter(Boolean);

  return (
    <>
      <PageHeader title="Settings" />
      <p className="mb-4 text-sm text-muted-foreground">Connections to the other systems in your home. An integration that is off does nothing, and agents can&apos;t use its tools.</p>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link href="/settings/integrations/home-assistant" className="underline-offset-2 hover:underline">
                Home Assistant
              </Link>
              <Badge variant={ha.enabled ? "default" : "outline"}>{ha.enabled ? "On" : "Off"}</Badge>
            </CardTitle>
            <CardDescription>
              Incidents from your automations and from Home Assistant&apos;s own health, notifications on your phone, MOSS&apos;s status as sensors, device
              names in the inventory, an internet self-heal, and a daily log review.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>
              {ha.enabled && features.length ? `Using: ${features.join(", ")}.` : ha.enabled ? "On, but no features are switched on yet." : c.host ? `Set up for ${c.host}, switched off.` : "Not set up."}
            </p>
            <Link href="/settings/integrations/home-assistant" className="w-fit border-2 px-3 py-2 font-mono text-sm hover:bg-muted">
              {c.host ? "Configure" : "Set up"}
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Device logs <Badge variant={syslog ? "default" : "outline"}>{syslog ? "On" : "Off"}</Badge>
            </CardTitle>
            <CardDescription>
              Syslog from your firewalls, switches and servers, through MOSS&apos;s collector on port 514, so agents with the Device Logs skill can read
              what a device logged.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>
              {syslog ? (
                <>
                  On. Set up your devices and read their logs in{" "}
                  <Link href="/monitoring/logs" className="underline underline-offset-2">
                    Monitoring → Logs
                  </Link>
                  .
                </>
              ) : (
                "Off: lines from the collector are refused."
              )}
            </p>
            <ActionForm action={setSyslogEnabledAction.bind(null, !syslog)} submitLabel={syslog ? "Switch off" : "Switch on"} submitVariant="outline" />
          </CardContent>
        </Card>
        {chats
          .filter(({ p }) => CHAT_PLAN[p] === "free")
          .map(({ p, it }) => (
            <ChatCard key={p} p={p} enabled={it.enabled} people={links.filter((l) => l.platform === p).length} />
          ))}
        {others
          .filter(({ def }) => def.plan !== "business")
          .map(({ def, it }) => (
            <IntegrationCard key={def.key} def={def} it={it} />
          ))}
      </div>
      {business.length > 0 && (
        <section aria-labelledby="business" className="mt-10 grid gap-4">
          <div className="grid gap-1">
            <h2 id="business" className="flex items-center gap-2 font-medium">
              Business <Badge variant="outline">{licence.state === "valid" || licence.state === "grace" ? "Licensed" : "Needs a licence"}</Badge>
            </h2>
            <p className="text-sm text-muted-foreground">
              For companies: single sign-on, the tools your team works in, and cloud and network services.{" "}
              {licence.state === "valid" || licence.state === "grace" ? (
                <>Your licence is in Settings → About.</>
              ) : (
                <>
                  They need a business licence:{" "}
                  <Link href="/settings/about#licence" className="underline underline-offset-2">
                    add one in Settings → About
                  </Link>
                  .
                </>
              )}
            </p>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            {chats
              .filter(({ p }) => CHAT_PLAN[p] === "business")
              .map(({ p, it }) => (
                <ChatCard key={p} p={p} enabled={it.enabled} people={links.filter((l) => l.platform === p).length} locked={!integrationAllowed({ key: p, plan: "business" }, licence)} />
              ))}
            {business.map(({ def, it }) => (
              <IntegrationCard key={def.key} def={def} it={it} locked={!integrationAllowed(def, licence)} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

type Loaded = Awaited<ReturnType<typeof loadIntegration>>;

/** One integration: on or off, what it's using, and a link to set it up (none while it needs a licence). */
function IntegrationCard({ def, it, locked = false }: { def: IntegrationDef; it: Loaded; locked?: boolean }) {
  const on = def.features.filter((f) => it.config.features[f.key]).map((f) => f.label.toLowerCase());
  if (locked) {
    return (
      <Card className="opacity-60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {def.name} <Badge variant="outline">Business licence</Badge>
          </CardTitle>
          <CardDescription>{def.description}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <Link href={`/settings/integrations/${def.key}`} className="underline underline-offset-2">
            What it does
          </Link>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link href={`/settings/integrations/${def.key}`} className="underline-offset-2 hover:underline">
            {def.name}
          </Link>
          <Badge variant={it.enabled ? "default" : "outline"}>{it.enabled ? "On" : "Off"}</Badge>
        </CardTitle>
        <CardDescription>{def.description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p>
          {it.enabled && on.length
            ? `Using: ${on.join(", ")}.`
            : it.enabled
              ? "On, but no features are switched on yet."
              : it.config.host || it.config.hosts.length
                ? `Set up for ${it.config.host ?? it.config.hosts.map((h) => h.host).join(", ")}, switched off.`
                : "Not set up."}
        </p>
        <Link href={`/settings/integrations/${def.key}`} className="w-fit border-2 px-3 py-2 font-mono text-sm hover:bg-muted">
          {it.config.host || it.config.hosts.length ? "Configure" : "Set up"}
        </Link>
      </CardContent>
    </Card>
  );
}

/** A chat app: on or off, how many people are connected, and a link to set it up (none while it needs a licence). */
function ChatCard({ p, enabled, people, locked = false }: { p: ChatPlatform; enabled: boolean; people: number; locked?: boolean }) {
  const what = `Alerts on your phone, Approve and Reject buttons for changes, and your agents to talk to, through your own ${CHAT_NAMES[p]} ${p === "slack" ? "app" : "bot"}.`;
  if (locked) {
    return (
      <Card className="opacity-60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {CHAT_NAMES[p]} <Badge variant="outline">Business licence</Badge>
          </CardTitle>
          <CardDescription>{what}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <Link href={`/settings/integrations/${p}`} className="underline underline-offset-2">
            What it does
          </Link>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link href={`/settings/integrations/${p}`} className="underline-offset-2 hover:underline">
            {CHAT_NAMES[p]}
          </Link>
          <Badge variant={enabled ? "default" : "outline"}>{enabled ? "On" : "Off"}</Badge>
        </CardTitle>
        <CardDescription>{what}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p>{enabled ? `On, ${people} person${people === 1 ? "" : "s"} connected.` : "Not set up."}</p>
        <Link href={`/settings/integrations/${p}`} className="w-fit border-2 px-3 py-2 font-mono text-sm hover:bg-muted">
          {enabled ? "Configure" : "Set up"}
        </Link>
      </CardContent>
    </Card>
  );
}
