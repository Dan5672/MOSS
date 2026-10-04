import { getSetting } from "@moss/core";
import { changeRequests, monitors, notifications } from "@moss/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { OctagonPause } from "lucide-react";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { logoutAction } from "../(public)/actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const [killSwitch, [pending], [unread], [down]] = await Promise.all([
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
  ]);
  const badges = {
    "/changes": user.permissions.has("changes.approve") ? (pending?.n ?? 0) : 0,
    "/monitoring": user.permissions.has("monitoring.read") ? (down?.n ?? 0) : 0,
  };

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-muted/30 p-3 md:flex">
        <Link href="/" className="mb-4 px-3 pt-2">
          <div className="text-xl font-bold tracking-tight">MOSS</div>
          <div className="text-xs text-muted-foreground">Your AI IT department</div>
        </Link>
        <Nav badges={badges} />
        <div className="mt-auto border-t pt-3 text-sm">
          <div className="truncate px-3 font-medium">{user.displayName}</div>
          <div className="truncate px-3 text-xs text-muted-foreground">{user.email}</div>
          <form action={logoutAction} className="mt-2 px-1">
            <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
              Sign out
            </Button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Small screens: the sidebar collapses into a menu. */}
        <details className="border-b p-3 md:hidden">
          <summary className="cursor-pointer list-none font-bold tracking-tight">☰ MOSS</summary>
          <div className="mt-3">
            <Nav badges={badges} />
            <form action={logoutAction} className="mt-2">
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </details>
        {killSwitch && (
          <div role="status" className="flex items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-6 py-2 text-sm text-red-700 dark:text-red-300">
            <OctagonPause className="size-4" aria-hidden />
            <span>
              <strong>All agents are paused</strong> by the kill switch. Nothing will run until it is turned off in{" "}
              <Link href="/settings" className="underline">
                Settings
              </Link>
              .
            </span>
          </div>
        )}
        {(unread?.n ?? 0) > 0 && (
          <div className="border-b bg-muted/40 px-6 py-2 text-sm">
            You have {unread!.n} unread notification{unread!.n === 1 ? "" : "s"}.{" "}
            <Link href="/notifications" className="underline">
              View
            </Link>
          </div>
        )}
        <main className="mx-auto w-full max-w-6xl flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
