"use server";

import { writeAudit } from "@moss/core";
import { users } from "@moss/db";
import { eq } from "drizzle-orm";
import { act, type ActionState } from "@/server/action";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";

/** Stops signing in with a linked account (only for someone who also has a password, so they can still get in). */
export async function unlinkSsoAction(_: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    if (!user.hasPassword) throw new Error("You sign in only with this account, so it can't be unlinked. Ask an admin.");
    await db().update(users).set({ oidcSubject: null, updatedAt: new Date() }).where(eq(users.id, user.id));
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "auth.sso_unlinked", targetType: "user", targetId: user.id });
    return "Unlinked. Sign in with your MOSS password.";
  });
}
