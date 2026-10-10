import { listMonitors } from "@moss/core";
import { assets, assetServices, incidentAssets, incidents, networks } from "@moss/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Pill, PriorityBadge, StatusBadge } from "@/components/badges";
import { TextAreaField, TextField } from "@/components/field";
import { Empty, PageHeader, Section, timeAgo, NoPermission } from "@/components/page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { lockAssetAction, retireAssetAction, updateAssetAction } from "../actions";

export default async function AssetPage({ params }: PageProps<"/assets/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  if (!user.permissions.has("assets.read")) return <NoPermission />;
  const [asset] = await db().select().from(assets).where(and(eq(assets.id, id), eq(assets.orgId, user.orgId)));
  if (!asset) notFound();
  const canMonitor = user.permissions.has("monitoring.read");
  const [services, linked, [network], assetMonitors] = await Promise.all([
    db().select().from(assetServices).where(eq(assetServices.assetId, id)),
    db()
      .select({ incident: incidents })
      .from(incidentAssets)
      .innerJoin(incidents, eq(incidentAssets.incidentId, incidents.id))
      .where(eq(incidentAssets.assetId, id))
      .orderBy(desc(incidents.createdAt)),
    asset.networkId ? db().select().from(networks).where(eq(networks.id, asset.networkId)) : Promise.resolve([]),
    canMonitor ? listMonitors(db(), user.orgId, { assetId: id }) : Promise.resolve([]),
  ]);
  const canAddMonitor = user.permissions.has("monitoring.manage") && !!asset.primaryIp;
  const monitorLink = (kind: string, port?: number, scheme?: string, name?: string) =>
    `/monitoring?${new URLSearchParams({ new: "1", kind, asset: id, target: asset.primaryIp ?? "", name: name ?? asset.name, ...(port ? { port: String(port) } : {}), ...(scheme ? { scheme } : {}) })}#new`;
  const canManage = user.permissions.has("assets.manage");
  const attributes = Object.entries(asset.attributes);

  return (
    <>
      <PageHeader
        title={asset.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {asset.kind} <StatusBadge status={asset.status} /> {asset.locked && <Pill>locked</Pill>}
            <span className="text-xs">
              Source: {asset.source} · confidence {asset.confidence}% · first seen <span className="font-mono">{timeAgo(asset.firstSeenAt)}</span> · last seen <span className="font-mono">{timeAgo(asset.lastSeenAt)}</span>
            </span>
          </span>
        }
        actions={
          canManage && (
            <>
              <ActionForm action={lockAssetAction.bind(null, id, !asset.locked)} submitLabel={asset.locked ? "Unlock" : "Lock"} submitVariant="outline" />
              {asset.status !== "retired" && (
                <ActionForm action={retireAssetAction.bind(null, id)} submitLabel="Retire" submitVariant="outline" confirm="Retire this asset? It will be hidden from the inventory." />
              )}
            </>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section title="Network">
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1 px-frame p-4 text-sm">
              <dt className="text-muted-foreground">IP</dt>
              <dd className="font-mono">{asset.primaryIp ?? "—"}</dd>
              <dt className="text-muted-foreground">MAC</dt>
              <dd className="font-mono">{asset.primaryMac ?? "—"}</dd>
              <dt className="text-muted-foreground">Vendor</dt>
              <dd>{asset.vendor ?? "—"}</dd>
              <dt className="text-muted-foreground">Hostnames</dt>
              <dd>{asset.hostnames.join(", ") || "—"}</dd>
              <dt className="text-muted-foreground">Network</dt>
              <dd>{network ? <>{network.name ?? network.cidr} <span className="font-mono">({network.cidr})</span></> : "—"}</dd>
              <dt className="text-muted-foreground">OS / model</dt>
              <dd>{[asset.os, asset.model].filter(Boolean).join(" · ") || "—"}</dd>
            </dl>
          </Section>
          <Section title="Open services">
            {services.length === 0 ? (
              <Empty>No open services recorded.</Empty>
            ) : (
              <ul className="divide-y-2 px-frame text-sm">
                {services.map((s) => (
                  <li key={s.id} className="flex justify-between gap-3 p-3">
                    <span className="font-mono">
                      {s.port}/{s.protocol}
                    </span>
                    <span className="text-muted-foreground">{[s.name, s.product, s.version].filter(Boolean).join(" · ")}</span>
                    <span className="font-mono text-xs text-muted-foreground">{timeAgo(s.lastSeenAt)}</span>
                    {canAddMonitor && s.protocol === "tcp" && (
                      <Link
                        href={
                          /^https?$|^http-|^https-/.test(s.name ?? "") || [80, 443, 8080, 8443].includes(s.port)
                            ? monitorLink("http", s.port, s.name?.startsWith("https") || s.port === 443 || s.port === 8443 ? "https" : "http", `${asset.name} ${s.name ?? s.port}`)
                            : monitorLink("tcp", s.port, undefined, `${asset.name} ${s.name ?? s.port}`)
                        }
                        className="text-xs underline"
                      >
                        Monitor
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {attributes.length > 0 && (
            <Section title="Attributes">
              <dl className="grid grid-cols-[10rem_1fr] gap-y-1 px-frame p-4 text-sm">
                {attributes.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="break-all">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}
          {canMonitor && (
            <Section
              title="Monitors"
              actions={canAddMonitor && <Link href={monitorLink("ping", undefined, undefined, `${asset.name} reachable`)} className="text-sm underline">Add ping monitor</Link>}
            >
              {assetMonitors.length === 0 ? (
                <Empty>Nothing is watching this asset.</Empty>
              ) : (
                <ul className="divide-y-2 px-frame text-sm">
                  {assetMonitors.map((m) => (
                    <li key={m.id}>
                      <Link href={`/monitoring/${m.id}`} className="flex items-center gap-3 p-3 hover:bg-accent">
                        <StatusBadge status={m.state} /> {m.name}
                        <span className="ml-auto truncate text-xs text-muted-foreground">{m.lastResult?.message}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
          <Section title="Incidents">
            {linked.length === 0 ? (
              <Empty>No incidents involve this asset.</Empty>
            ) : (
              <ul className="divide-y-2 px-frame text-sm">
                {linked.map(({ incident }) => (
                  <li key={incident.id}>
                    <Link href={`/incidents/${incident.id}`} className="flex items-center gap-3 p-3 hover:bg-accent">
                      <PriorityBadge priority={incident.priority} /> <StatusBadge status={incident.status} /> {incident.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        {canManage && (
          <Card>
            <CardHeader>
              <CardTitle>Edit</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm action={updateAssetAction.bind(null, id)} submitLabel="Save">
                <TextField label="Name" name="name" defaultValue={asset.name} required />
                <TextField label="Kind" name="kind" defaultValue={asset.kind} required />
                <TextField label="Vendor" name="vendor" defaultValue={asset.vendor ?? ""} />
                <TextField label="Model" name="model" defaultValue={asset.model ?? ""} />
                <TextField label="OS" name="os" defaultValue={asset.os ?? ""} />
                <TextAreaField label="Notes" name="notes" rows={4} defaultValue={asset.notes ?? ""} />
              </ActionForm>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
