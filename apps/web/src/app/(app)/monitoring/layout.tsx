import { getSetting } from "@moss/core";
import type { ReactNode } from "react";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { MonitoringTabs } from "./tabs";

/** The section's tabs sit above every page in it, so they never move. */
export default async function Layout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const map = await getSetting(db(), user.orgId, "monitoring.dependencies");
  return (
    <>
      <MonitoringTabs map={map} />
      {children}
    </>
  );
}
