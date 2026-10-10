import { loadHomeAssistant } from "@moss/core";
import Link from "next/link";
import { NoPermission, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";

export const metadata = { title: "Modules" };

export default async function ModulesPage() {
  const user = await requireUser();
  if (!user.permissions.has("integrations.manage")) return <NoPermission />;
  const ha = await loadHomeAssistant(db(), user.orgId);
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
      <p className="mb-4 text-sm text-muted-foreground">Optional parts of MOSS. A module that is off does nothing, and agents can&apos;t use its tools.</p>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link href="/settings/modules/home-assistant" className="underline-offset-2 hover:underline">
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
            <Link href="/settings/modules/home-assistant" className="w-fit border-2 px-3 py-2 font-mono text-sm hover:bg-muted">
              {c.host ? "Configure" : "Set up"}
            </Link>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
