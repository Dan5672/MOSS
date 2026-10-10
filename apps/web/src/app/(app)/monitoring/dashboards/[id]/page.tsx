import { canEditDashboard, dashboardData, getDashboard } from "@moss/core";
import { notFound } from "next/navigation";
import { widgetCards } from "@/components/monitoring-dashboard/cards";
import { DashboardEditor } from "@/components/monitoring-dashboard/dashboard-editor";
import { LiveRefresh } from "@/components/live-refresh";
import { NoPermission, PageHeader } from "@/components/page";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { monitorOptions } from "../shared";

export default async function DashboardPage({ params, searchParams }: PageProps<"/monitoring/dashboards/[id]">) {
  const user = await requireUser();
  if (!user.permissions.has("monitoring.read")) return <NoPermission />;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const d = await getDashboard(db(), user.orgId, user.id, id);
  if (!d) notFound();
  const viewer = { userId: user.id, canManage: user.permissions.has("monitoring.manage") };
  const canEdit = canEditDashboard(d, viewer);
  const [data, monitors] = await Promise.all([dashboardData(db(), user.orgId, d.widgets), canEdit ? monitorOptions(user.orgId) : []]);

  return (
    <>
      <PageHeader title={d.name} description={d.shared ? "Shared with everyone who can see monitoring." : "Only you can see this dashboard."} />
      <DashboardEditor
        dashboard={{ id: d.id, name: d.name, shared: d.shared, widgets: d.widgets }}
        cards={widgetCards(d.widgets, data)}
        monitors={monitors}
        canEdit={canEdit}
        canShare={viewer.canManage}
        startEditing={sp.edit === "1"}
      />
      {/* Fresh numbers every minute. An edit in progress survives it: the layout being edited lives in the editor. */}
      <LiveRefresh everyMs={60_000} />
    </>
  );
}
