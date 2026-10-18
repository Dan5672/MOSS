import { getSetting } from "@moss/core";
import { monitors } from "@moss/db";
import { eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Empty, NoPermission, PageHeader } from "@/components/page";
import { layoutDependencies } from "@/lib/dependency-map";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { setDependenciesAction } from "../actions";

export const metadata = { title: "Dependency map" };

const W = 200;
const H = 40;
const COL = W + 64;
const ROW = H + 12;

/** Border and fill for a monitor's state; a quiet outage (waiting on what it depends on) is dashed. */
const STATE_STYLE: Record<string, string> = {
  down: "stroke-alarm fill-alarm/15",
  degraded: "stroke-amber fill-amber/15",
  up: "stroke-phosphor fill-phosphor/10",
};

const short = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export default async function DependencyMapPage() {
  const user = await requireUser();
  if (!user.permissions.has("monitoring.read")) return <NoPermission />;
  const canManage = user.permissions.has("monitoring.manage");
  const on = await getSetting(db(), user.orgId, "monitoring.dependencies");
  const rows = await db()
    .select({ id: monitors.id, name: monitors.name, parentId: monitors.parentMonitorId, state: monitors.state, lastResult: monitors.lastResult })
    .from(monitors)
    .where(eq(monitors.orgId, user.orgId));
  const { placed, rows: rowCount, depth } = layoutDependencies(rows);
  const pos = new Map(placed.map((p) => [p.node.id, { x: p.depth * COL, y: p.row * ROW }]));
  const width = (depth + 1) * COL - (COL - W) + 2;
  const height = Math.max(1, rowCount) * ROW - (ROW - H) + 2;
  const alone = rows.length - placed.length;

  const header = (
    <PageHeader
      title="Dependency map"
      description="What each monitor depends on. While a monitor is down or failing, the ones that depend on it stay quiet: one alarm for the host, not one per VM."
      actions={canManage && on && <ActionForm action={setDependenciesAction.bind(null, false)} submitLabel="Turn off dependencies" submitVariant="outline" confirm="Turn off dependencies? Every monitor raises its own alarm again. What you set is kept for when you turn them back on." />}
    />
  );
  if (!on) {
    return (
      <>
        {header}
        <Empty>
          Dependencies are off.{" "}
          {canManage ? <ActionForm action={setDependenciesAction.bind(null, true)} submitLabel="Turn them on" submitVariant="outline" inline /> : "Someone who manages monitoring can turn them on."}
        </Empty>
      </>
    );
  }

  return (
    <>
      {header}
      {placed.length === 0 ? (
        <Empty>No dependencies yet. Open a monitor, choose what it depends on under Edit (such as the Proxmox host for a VM), and save.</Empty>
      ) : (
        <div className="overflow-x-auto border-2 p-4">
          <svg width={width} height={height} viewBox={`-1 -1 ${width} ${height}`} role="img" aria-label="Monitor dependency map" className="block">
            {placed.map(({ node }) => {
              const from = node.parentId ? pos.get(node.parentId) : undefined;
              const to = pos.get(node.id)!;
              if (!from) return null;
              const [x1, y1, x2, y2] = [from.x + W, from.y + H / 2, to.x, to.y + H / 2];
              const mid = (x1 + x2) / 2;
              return <path key={`e-${node.id}`} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} className="fill-none stroke-border" strokeWidth={2} />;
            })}
            {placed.map(({ node }) => {
              const { x, y } = pos.get(node.id)!;
              const quiet = node.state === "down" && !!node.lastResult?.parentDown;
              const label = `${node.name}: ${node.state}${quiet ? `, quiet while ${node.lastResult!.parentDown} is down` : ""}`;
              return (
                <a key={node.id} href={`/monitoring/${node.id}`} aria-label={label} className="focus-visible:outline-none [&:focus-visible>rect]:stroke-ring">
                  <title>{label}</title>
                  <rect x={x} y={y} width={W} height={H} strokeWidth={2} strokeDasharray={quiet ? "5 4" : undefined} className={cn(STATE_STYLE[node.state] ?? "fill-card stroke-border")} />
                  <text x={x + 12} y={y + H / 2} dominantBaseline="central" className="fill-foreground text-[13px]">
                    {short(node.name)}
                  </text>
                </a>
              );
            })}
          </svg>
        </div>
      )}
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-muted-foreground" aria-label="Legend">
        <li className="flex items-center gap-2"><span className="size-3 border-2 border-phosphor" /> up</li>
        <li className="flex items-center gap-2"><span className="size-3 border-2 border-amber" /> degraded</li>
        <li className="flex items-center gap-2"><span className="size-3 border-2 border-alarm" /> down</li>
        <li className="flex items-center gap-2"><span className="size-3 border-2 border-dashed border-alarm" /> down, quiet (waiting on what it depends on)</li>
        <li className="flex items-center gap-2"><span className="size-3 border-2" /> paused or not checked yet</li>
      </ul>
      {alone > 0 && placed.length > 0 && <p className="mt-2 text-sm text-muted-foreground">{alone} monitor(s) don&apos;t depend on anything and nothing depends on them, so they aren&apos;t shown.</p>}
    </>
  );
}
