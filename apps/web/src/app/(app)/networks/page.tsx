import { listNetworks, setNetworkDns, setNetworkStatus } from "@moss/core";
import { assets } from "@moss/db";
import { and, count, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/badges";
import { SelectField, TextField } from "@/components/field";
import { Empty, PageHeader, timeAgo, NoPermission } from "@/components/page";
import { FormDialog } from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
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

async function setDnsAction(networkId: string, _: ActionState, form: FormData): Promise<ActionState> {
  "use server";
  return act(async () => {
    const user = await requirePermission("networks.manage");
    const row = await setNetworkDns(db(), user.orgId, networkId, String(form.get("dnsServer") ?? ""), user.id);
    return row.dnsServer ? `Scans of ${row.cidr} now look names up with ${row.dnsServer}.` : `${row.cidr} has no DNS server set.`;
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
        description="Decide which networks your agents may work on. Anything not allowed is refused by the policy gate. Public internet addresses need no entry for monitors and light checks (ping, TCP, HTTP, TLS); scanning, signing in and changes always need an allowed network."
        actions={
          canManage && (
            <FormDialog label="Add a network" title="Add a network" description="Only add networks you own or are authorised to scan.">
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
            </FormDialog>
          )
        }
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
              <TableHead>DNS server</TableHead>
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
                <TableCell>
                  {canManage ? (
                    <ActionForm action={setDnsAction.bind(null, n.id)} submitLabel="Set" submitVariant="outline" inline>
                      <Input aria-label={`DNS server for ${n.cidr}`} name="dnsServer" defaultValue={n.dnsServer ?? ""} placeholder="e.g. your router" className="w-36 font-mono" />
                    </ActionForm>
                  ) : (
                    <span className="font-mono text-sm">{n.dnsServer ?? "—"}</span>
                  )}
                </TableCell>
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

    </>
  );
}
