import { searchAssets } from "@moss/core";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Pill } from "@/components/badges";
import { TextAreaField, TextField } from "@/components/field";
import { Empty, PageHeader, timeAgo, NoPermission } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { addAssetAction } from "./actions";

export const metadata = { title: "Assets" };

export default async function AssetsPage({ searchParams }: PageProps<"/assets">) {
  const user = await requireUser();
  if (!user.permissions.has("assets.read")) return <NoPermission />;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const isIp = /^[0-9a-f:.]+(\/\d+)?$/i.test(q) && /[.:]/.test(q);
  const rows = await searchAssets(db(), user.orgId, isIp ? { ip: q, limit: 200 } : { query: q || undefined, limit: 200 });

  return (
    <>
      <PageHeader title="Assets" description="Everything MOSS knows is on your network. Agents add what they discover; lock an asset to stop agents changing it." />
      <form className="mb-4 flex gap-2" role="search">
        <Input name="q" defaultValue={q} placeholder="Search by name, IP, CIDR, MAC, vendor or notes" aria-label="Search assets" className="max-w-md" />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {rows.length === 0 ? (
        <Empty>{q ? "No assets match." : "No assets yet. Allow a network and let your Network Admin discover it."}</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>MAC / vendor</TableHead>
              <TableHead>Open ports</TableHead>
              <TableHead>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <Link href={`/assets/${a.id}`} className="font-medium hover:underline">
                    {a.name}
                  </Link>
                  {a.locked && <Pill className="ml-2">locked</Pill>}
                </TableCell>
                <TableCell className="text-sm">{a.kind}</TableCell>
                <TableCell className="font-mono text-xs">{a.primaryIp ?? "—"}</TableCell>
                <TableCell className="text-xs">
                  <div className="font-mono">{a.primaryMac ?? "—"}</div>
                  <div className="text-muted-foreground">{a.vendor}</div>
                </TableCell>
                <TableCell className="font-mono text-xs">{a.services.map((s) => s.port).join(", ") || "—"}</TableCell>
                <TableCell className="font-mono text-sm whitespace-nowrap">{timeAgo(a.lastSeenAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {user.permissions.has("assets.manage") && (
        <Card className="mt-8 max-w-xl">
          <CardHeader>
            <CardTitle>Add an asset manually</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={addAssetAction} submitLabel="Add asset" resetOnSuccess>
              <TextField label="Name" name="name" required />
              <div className="grid grid-cols-2 gap-2">
                <TextField label="Kind" name="kind" placeholder="printer" />
                <TextField label="IP address" name="ip" />
              </div>
              <TextField label="MAC address" name="mac" />
              <TextAreaField label="Notes" name="notes" rows={2} />
            </ActionForm>
          </CardContent>
        </Card>
      )}
    </>
  );
}
