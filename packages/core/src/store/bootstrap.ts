// First-run bootstrap: default org, built-in roles, and the owner account.
import { orgs, rolePermissions, roles, userRoles, users, type Database } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";
import { BUILT_IN_ROLES } from "../auth/rbac.js";
import { writeAudit } from "./audit-store.js";

export async function ensureBuiltInRoles(db: Database, orgId: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [key, def] of Object.entries(BUILT_IN_ROLES)) {
    let [role] = await db.select().from(roles).where(and(eq(roles.orgId, orgId), eq(roles.key, key)));
    if (!role) [role] = await db.insert(roles).values({ orgId, key, name: def.name, builtIn: true }).returning();
    const roleId = role!.id;
    ids[key] = roleId;
    // Built-in roles are re-synced on every boot so upgrades can add permissions.
    await db.transaction(async (tx) => {
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
      await tx.insert(rolePermissions).values(def.permissions.map((permission) => ({ roleId, permission })));
    });
  }
  return ids;
}

export interface BootstrapInput {
  orgName: string;
  ownerEmail: string;
  ownerName: string;
  ownerPassword: string;
}

/** Creates the org and owner. Refuses to run twice. */
export async function bootstrapOrg(db: Database, input: BootstrapInput) {
  const existing = await db.select({ id: orgs.id }).from(orgs).limit(1);
  if (existing.length > 0) throw new Error("MOSS is already set up");
  const passwordHash = await hashPassword(input.ownerPassword);
  const [org] = await db.insert(orgs).values({ name: input.orgName }).returning();
  const roleIds = await ensureBuiltInRoles(db, org!.id);
  const [owner] = await db
    .insert(users)
    .values({ orgId: org!.id, email: input.ownerEmail.toLowerCase(), displayName: input.ownerName, passwordHash })
    .returning();
  await db.insert(userRoles).values({ userId: owner!.id, roleId: roleIds.owner! });
  await writeAudit(db, {
    orgId: org!.id,
    actorType: "system",
    action: "org.bootstrap",
    targetType: "user",
    targetId: owner!.id,
    details: { orgName: input.orgName, ownerEmail: owner!.email },
  });
  return { org: org!, owner: owner!, roleIds };
}
