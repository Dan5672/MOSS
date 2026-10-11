import { ensureStarterDashboard, listDashboards } from "@moss/core";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Pill } from "@/components/badges";
import { CheckboxField, TextField } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Empty, NoPermission, PageHeader, timeAgo } from "@/components/page";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { createDashboardAction } from "./actions";

export const metadata = { title: "Dashboards" };

/** Monitoring dashboards: shared ones first, then your own. */
export default async function DashboardsPage() {
  const user = await requireUser();
  if (!user.permissions.has("monitoring.read")) return <NoPermission />;
  // The first visit makes a shared Overview from the monitors there are.
  await ensureStarterDashboard(db(), user.orgId, { type: "user", id: user.id });
  const list = await listDashboards(db(), user.orgId, user.id);
  const canManage = user.permissions.has("monitoring.manage");

  return (
    <>
      <PageHeader
        title="Monitoring"
        description="Graphs, gauges and status at a glance. Shared dashboards are for everyone; your own are just for you. Open one in TV mode for a wall screen."
        actions={
          <FormDialog label="New dashboard" title="New dashboard" description="Then add cards: graphs, gauges, values, up/down history, a status grid, top lists, incidents and notes.">
            <ActionForm action={createDashboardAction} submitLabel="Create dashboard">
              <TextField label="Name" name="name" placeholder="Network" maxLength={80} required />
              {canManage && <CheckboxField label="Shared with everyone who can see monitoring" name="shared" />}
            </ActionForm>
          </FormDialog>
        }
      />
      {list.length === 0 ? (
        <Empty>No dashboards yet. Add a monitor first, or create an empty dashboard.</Empty>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Dashboards">
          {list.map((d) => (
            <li key={d.id}>
              <Link href={`/monitoring/dashboards/${d.id}`} className="grid gap-2 border-2 p-4 hover:bg-accent">
                <span className="flex items-center gap-2 font-medium">
                  {d.name} <Pill tone={d.shared ? "blue" : "gray"}>{d.shared ? "shared" : "yours"}</Pill>
                </span>
                <span className="text-sm text-muted-foreground">
                  {d.widgets.length} card{d.widgets.length === 1 ? "" : "s"} · changed {timeAgo(d.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
