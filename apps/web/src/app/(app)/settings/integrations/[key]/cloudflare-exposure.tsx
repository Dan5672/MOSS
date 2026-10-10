import { acknowledgedHostnames, getIntegration, loadIntegration, type CloudflareState } from "@moss/core";
import { ActionForm } from "@/components/action-form";
import { timeAgo } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/server/db";
import { acknowledgeHostnamesAction, forgetHostnameAction } from "./cloudflare-actions";

const VIA = { proxied: "Proxied by Cloudflare", tunnel: "Cloudflare Tunnel", "public address": "Points at a public address" } as const;

/** Every hostname the internet can reach through Cloudflare, and which ones are expected. */
export async function CloudflareExposureCard({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const { config, state } = await loadIntegration(db(), orgId, getIntegration("cloudflare")!);
  const report = (state as CloudflareState).exposure;
  const known = new Set(acknowledgedHostnames(config));
  const fresh = report?.hostnames.filter((h) => !known.has(h.name)) ?? [];

  return (
    <Card id="exposure" className="scroll-mt-6 lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Public hostnames {fresh.length > 0 && <Badge variant="destructive">{fresh.length} new</Badge>}
        </CardTitle>
        <CardDescription>
          Everything reachable from the internet through Cloudflare: proxied records, records pointing at public addresses, and tunnel routes.
          {report ? ` Last checked ${timeAgo(new Date(report.at))}.` : " Not checked yet: switch on the exposure report, then Sync now."}
        </CardDescription>
      </CardHeader>
      {report && (
        <CardContent className="space-y-3">
          {report.hostnames.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing is public through Cloudflare.</p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {report.hostnames.map((h) => (
                <li key={h.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <span className="font-medium break-all">{h.name}</span>
                  <span className="text-muted-foreground break-all">
                    {VIA[h.via]} ({h.type} {h.content})
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    {known.has(h.name) ? <Badge variant="outline">Expected</Badge> : <Badge variant="destructive">New</Badge>}
                    {canManage &&
                      (known.has(h.name) ? (
                        <ActionForm action={forgetHostnameAction.bind(null, h.name)} submitLabel="Unmark" submitVariant="secondary" inline />
                      ) : (
                        <ActionForm action={acknowledgeHostnamesAction.bind(null, h.name)} submitLabel="Mark as expected" submitVariant="outline" inline />
                      ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canManage && fresh.length > 1 && <ActionForm action={acknowledgeHostnamesAction.bind(null, null)} submitLabel="Mark all as expected" />}
        </CardContent>
      )}
    </Card>
  );
}
