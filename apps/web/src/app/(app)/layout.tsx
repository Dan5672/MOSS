import { getSetting } from "@moss/core";
import { changeRequests, incidents, monitors, notifications } from "@moss/db";
import { and, count, eq, isNull, notInArray } from "drizzle-orm";
import Link from "next/link";
import { KillSwitchPanel } from "@/components/kill-switch-panel";
import { Logo } from "@/components/logo";
import { Nav } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { logoutAction } from "../(public)/actions";
import { toggleSettingAction } from "./settings/actions";

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const [killSwitch, [pending], [unread], [down], [open]] = await Promise.all([
    getSetting(db(), user.orgId, "agents.kill_switch"),
    db()
      .select({ n: count() })
      .from(changeRequests)
      .where(and(eq(changeRequests.orgId, user.orgId), eq(changeRequests.status, "submitted"))),
    db()
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt))),
    db()
      .select({ n: count() })
      .from(monitors)
      .where(and(eq(monitors.orgId, user.orgId), eq(monitors.state, "down"))),
    db()
      .select({ n: count() })
      .from(incidents)
      .where(and(eq(incidents.orgId, user.orgId), notInArray(incidents.status, ["resolved", "closed"]))),
  ]);
  const badges = {
    "/changes": user.permissions.has("changes.approve") ? (pending?.n ?? 0) : 0,
    "/monitoring": user.permissions.has("monitoring.read") ? (down?.n ?? 0) : 0,
    "/incidents": user.permissions.has("incidents.read") ? (open?.n ?? 0) : 0,
  };
  const killSwitchPanel = user.permissions.has("killswitch.use") && (
    <KillSwitchPanel paused={killSwitch} toggle={toggleSettingAction.bind(null, "agents.kill_switch", !killSwitch)} />
  );
  const signOut = (
    <form action={logoutAction}>
      <Button type="submit" variant="ghost" size="sm" className="w-full justify-start font-mono">
        Sign out
      </Button>
    </form>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-62 shrink-0 flex-col gap-4 overflow-y-auto border-r-2 bg-card p-3 md:flex">
        <Link href="/" className="px-2 pt-2">
          <Logo variant="horizontal" />
        </Link>
        <Nav badges={badges} />
        <div className="mt-auto grid gap-3">
          {killSwitchPanel}
          <div className="grid gap-2 border-t-2 pt-3 text-sm">
            <div className="flex items-center gap-2 px-1">
              <span aria-hidden className="grid size-8 shrink-0 place-items-center bg-[#2b3a33] font-mono text-xs text-beige">
                {initials(user.displayName)}
              </span>
              <div className="min-w-0">
                <div className="truncate font-medium">{user.displayName}</div>
                <div className="truncate font-mono text-xs text-dim">{user.email}</div>
              </div>
            </div>
            {signOut}
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Small screens: the sidebar collapses into a menu. */}
        <details className="border-b-2 bg-card p-3 md:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
            <Logo variant="horizontal" />
            <span className="border-2 px-3 py-2 font-mono text-xs">Menu</span>
          </summary>
          <div className="mt-3 grid gap-3">
            <Nav badges={badges} />
            {killSwitchPanel}
            {signOut}
          </div>
        </details>
        {killSwitch && (
          <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-alarm px-6 py-2 font-mono text-sm text-on-brand">
            <span>
              <strong className="font-medium uppercase">All agents are paused</strong> · no tool calls will run until you resume
            </span>
            <Link href="/settings" className="underline underline-offset-2">
              Settings
            </Link>
          </div>
        )}
        {(unread?.n ?? 0) > 0 && (
          <div className="border-b-2 px-6 py-2 text-sm">
            You have {unread!.n} unread notification{unread!.n === 1 ? "" : "s"}.{" "}
            <Link href="/notifications" className="underline">
              View
            </Link>
          </div>
        )}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pt-6 pb-12 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
