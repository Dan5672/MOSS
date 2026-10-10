import { INTEGRATIONS, loadHomeAssistant, loadIntegration } from "@moss/core";
import Link from "next/link";
import { NoPermission, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";

export const metadata = { title: "Integrations" };

export default async function ModulesPage() {
  const user = await requireUser();
  if (!user.permissions.has("integrations.manage")) return <NoPermission />;
  const [ha, others] = await Promise.all([
    loadHomeAssistant(db(), user.orgId),
    Promise.all(INTEGRATIONS.map(async (def) => ({ def, it: await loadIntegration(db(), user.orgId, def) }))),
  ]);
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
        {others.map(({ def, it }) => {
          const on = def.features.filter((f) => it.config.features[f.key]).map((f) => f.label.toLowerCase());
          return (
            <Card key={def.key}>
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
                      : it.config.host
                        ? `Set up for ${it.config.host}, switched off.`
                        : "Not set up."}
                </p>
                <Link href={`/settings/integrations/${def.key}`} className="w-fit border-2 px-3 py-2 font-mono text-sm hover:bg-muted">
                  {it.config.host ? "Configure" : "Set up"}
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
