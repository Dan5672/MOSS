import { dashboardData, getDashboard } from "@moss/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardGrid } from "@/components/monitoring-dashboard/cards";
import { LiveRefresh } from "@/components/live-refresh";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { TvClock } from "./clock";

export const metadata = { title: "TV mode" };

/** A dashboard for a wall screen: full width, no menus, refreshing every 30 seconds. */
export default async function TvDashboardPage({ params }: PageProps<"/tv/dashboards/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const d = user.permissions.has("monitoring.read") ? await getDashboard(db(), user.orgId, user.id, id) : null;
  if (!d) notFound();
  const data = await dashboardData(db(), user.orgId, d.widgets);

  return (
    <main className="min-h-screen p-4">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="font-pixel text-lg text-ink dark:text-beige">{d.name}</h1>
        <div className="flex items-baseline gap-4 font-mono text-sm text-muted-foreground">
          <TvClock />
          <Link href={`/monitoring/dashboards/${d.id}`} className="underline-offset-2 hover:underline">
            Exit TV mode
          </Link>
        </div>
      </header>
      <DashboardGrid widgets={d.widgets} data={data} />
      <LiveRefresh everyMs={30_000} />
    </main>
  );
}
