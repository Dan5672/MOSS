// In-app notifications. External channels (email, push, chat, Home Assistant) build on these later.
import { notifications, rolePermissions, userRoles, users, type Database } from "@moss/db";
import { and, eq } from "drizzle-orm";
import type { Permission } from "../auth/rbac.js";

export async function userPermissions(db: Pick<Database, "select">, userId: string): Promise<Set<Permission>> {
  const rows = await db
    .select({ p: rolePermissions.permission })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(and(eq(userRoles.userId, userId), eq(users.status, "active")));
  return new Set(rows.map((r) => r.p as Permission));
}

export interface NotificationInput {
  kind: string;
  title: string;
  body?: string;
  link?: string;
}

/** Notifies every active user who holds the permission. */
export async function notifyPermission(db: Pick<Database, "selectDistinct" | "insert">, orgId: string, permission: Permission, n: NotificationInput) {
  const recipients = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
    .where(and(eq(users.orgId, orgId), eq(users.status, "active"), eq(rolePermissions.permission, permission)));
  if (recipients.length === 0) return 0;
  await db.insert(notifications).values(recipients.map((r) => ({ orgId, userId: r.id, kind: n.kind, title: n.title, body: n.body, link: n.link })));
  return recipients.length;
}
