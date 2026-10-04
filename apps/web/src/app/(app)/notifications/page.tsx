import { notifications } from "@moss/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Empty, PageHeader, timeAgo } from "@/components/page";
import { act, type ActionState } from "@/server/action";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";

export const metadata = { title: "Notifications" };

async function markAllReadAction(_: ActionState): Promise<ActionState> {
  "use server";
  return act(async () => {
    const user = await requireUser();
    await db().update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));
  });
}

export default async function NotificationsPage() {
  const user = await requireUser();
  const rows = await db().select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(desc(notifications.createdAt)).limit(100);
  return (
    <>
      <PageHeader title="Notifications" actions={rows.some((n) => !n.readAt) && <ActionForm action={markAllReadAction} submitLabel="Mark all read" submitVariant="outline" />} />
      {rows.length === 0 ? (
        <Empty>Nothing yet.</Empty>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((n) => (
            <li key={n.id} className={n.readAt ? "opacity-70" : ""}>
              <Link href={n.link ?? "#"} className="block p-3 hover:bg-accent/40">
                <div className="flex justify-between gap-3 text-sm">
                  <span className={n.readAt ? "" : "font-medium"}>{n.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(n.createdAt)}</span>
                </div>
                {n.body && <p className="line-clamp-2 text-sm text-muted-foreground">{n.body}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
