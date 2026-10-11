"use server";

import { users } from "@moss/db";
import { eq } from "drizzle-orm";
import { readLayout, type WidgetLayoutItem } from "@/components/widgets/registry";
import { act, type ActionState } from "@/server/action";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";

/** Saves this person's dashboard: which cards, in what order and size. */
export async function saveDashboardLayoutAction(layout: WidgetLayoutItem[]): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    const clean = readLayout(layout, undefined, []);
    await db()
      .update(users)
      .set({ preferences: { ...user.preferences, dashboard: clean }, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  });
}
