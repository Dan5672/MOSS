import "server-only";
import { monitors } from "@moss/db";
import { asc, eq } from "drizzle-orm";
import type { MonitorOption } from "@/components/monitoring-dashboard/widget-settings";
import { db } from "@/server/db";

/** The monitors widgets can show, with the named values each last recorded (for the metric picker). */
export async function monitorOptions(orgId: string): Promise<MonitorOption[]> {
  const rows = await db()
    .select({ id: monitors.id, name: monitors.name, kind: monitors.kind, lastResult: monitors.lastResult })
    .from(monitors)
    .where(eq(monitors.orgId, orgId))
    .orderBy(asc(monitors.name));
  return rows.map((m) => ({ id: m.id, name: m.name, kind: m.kind, metrics: Object.keys(m.lastResult?.values ?? {}) }));
}
