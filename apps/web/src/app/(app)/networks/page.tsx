import { listNetworks, setNetworkStatus } from "@moss/core";
import { assets } from "@moss/db";
import { and, count, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/badges";
import { SelectField, TextField } from "@/components/field";
import { Empty, PageHeader, timeAgo, NoPermission } from "@/components/page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission, requireUser } from "@/server/auth";
import { db } from "@/server/db";

export const metadata = { title: "Networks" };

async function setStatusAction(_: ActionState, form: FormData): Promise<ActionState> {
  "use server";
  return act(async () => {
    const user = await requirePermission("networks.manage");
    const input = z
      .object({ cidr: z.string().min(3).max(64), status: z.enum(["allowed", "off_limits", "unknown"]), name: z.string().max(100).optional() })
      .parse(formObject(form));
    const row = await setNetworkStatus(db(), user.orgId, input, user.id);
    return `${row.cidr} is now ${input.status.replace("_", " ")}.`;
  });
}

const STATUS_HELP = {
  allowed: "Agents may scan and manage it.",
  off_limits: "Agents may never touch it, even inside an allowed range.",
  unknown: "Seen but not decided. Agents may not touch it until you allow it.",
};

export default async function NetworksPage() {
  const user = await requireUser();
  if (!user.permissions.has("networks.read")) return <NoPermission />;
  const [rows, counts] = await Promise.all([
    listNetworks(db(), user.orgId),
    db()
      .select({ networkId: assets.networkId, n: count() })
      .from(assets)
      .where(and(eq(assets.orgId, user.orgId), ne(assets.status, "retired")))
      .groupBy(assets.networkId),
  ]);
  const canManage = user.permissions.has("networks.manage");

  return (
    <>
      <PageHeader
        title="Networks"
        description="Decide which networks your agents may work on. Anything not allowed is off limits: the policy gate refuses it."
      />
      {rows.length === 0 ? (
        <Empty>No networks yet. Add the subnet your devices are on (for example 192.168.1.0/24) and mark it allowed.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Network</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Assets</TableHead>
              <TableHead>Source</TableHead>
              {canManage && <TableHead className="text-right">Change</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((n) => (
              <TableRow key={n.id}>
                <TableCell>
                  <div className="font-mono">{n.cidr}</div>
                  <div className="text-xs text-muted-foreground">
                    {n.name ?? "Unnamed"}
                    {n.vlan ? ` · VLAN ${n.vlan}` : ""} · added <span className="font-mono">{timeAgo(n.createdAt)}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={n.status} />
                  <div className="mt-1 text-xs text-muted-foreground">{STATUS_HELP[n.status]}</div>
                </TableCell>
                <TableCell className="tabular-nums">{counts.find((c) => c.networkId === n.id)?.n ?? 0}</TableCell>
                <TableCell className="text-sm">{n.source}</TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {(["allowed", "off_limits"] as const)
                        .filter((s) => s !== n.status)
                        .map((s) => (
                          <ActionForm key={s} action={setStatusAction} submitLabel={s === "allowed" ? "Allow" : "Mark off limits"} submitVariant="outline">
                            <input type="hidden" name="cidr" value={n.cidr} />
                            <input type="hidden" name="status" value={s} />
                          </ActionForm>
                        ))}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {canManage && (
        <Card className="mt-8 max-w-xl">
          <CardHeader>
            <CardTitle>Add a network</CardTitle>
            <CardDescription>Only add networks you own or are authorised to scan.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={setStatusAction} submitLabel="Save network" resetOnSuccess>
              <div className="grid grid-cols-2 gap-2">
                <TextField label="CIDR" name="cidr" placeholder="192.168.1.0/24" required />
                <TextField label="Name" name="name" placeholder="Home LAN" />
              </div>
              <SelectField
                label="Status"
                name="status"
                options={[
                  { value: "allowed", label: "Allowed — agents may scan it" },
                  { value: "off_limits", label: "Off limits — agents may never touch it" },
                  { value: "unknown", label: "Unknown — decide later" },
                ]}
              />
            </ActionForm>
          </CardContent>
        </Card>
      )}
    </>
  );
}
