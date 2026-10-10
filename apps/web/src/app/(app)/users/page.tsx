import { roles, userRoles, users } from "@moss/db";
import { and, eq, ne } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Pill, StatusBadge } from "@/components/badges";
import { SelectField, TextField } from "@/components/field";
import { PageHeader, timeAgo, NoPermission } from "@/components/page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { addUserAction, setRoleAction, setUserStatusAction } from "./actions";

export const metadata = { title: "Users" };

const ROLE_HELP: Record<string, string> = {
  owner: "Everything, including managing owners",
  admin: "Everything except changing owners",
  change_approver: "Read everything; approve changes; work incidents",
  operator: "Read everything; work incidents; use the kill switch",
  viewer: "Read only",
};

export default async function UsersPage() {
  const me = await requireUser();
  if (!me.permissions.has("users.manage")) return <NoPermission />;
  const [userRows, roleRows] = await Promise.all([
    db()
      .select({ user: users, roleKey: roles.key, roleName: roles.name })
      .from(users)
      .leftJoin(userRoles, eq(userRoles.userId, users.id))
      .leftJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(users.orgId, me.orgId)),
    db().select().from(roles).where(and(eq(roles.orgId, me.orgId), ne(roles.key, "agent"))),
  ]);
  const roleOptions = roleRows.map((r) => ({ value: r.key, label: `${r.name} — ${ROLE_HELP[r.key] ?? "custom"}` }));

  return (
    <>
      <PageHeader title="Users" description="People who can sign in to MOSS. Agents are managed on the Agents page." />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last sign-in</TableHead>
            <TableHead className="text-right">Access</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {userRows.map(({ user, roleKey, roleName }) => {
            const self = user.id === me.id;
            return (
              <TableRow key={user.id}>
                <TableCell>
                  <div className="font-medium">
                    {user.displayName} {self && <Pill>you</Pill>} {user.totpSecretRef && <Pill tone="green">2FA</Pill>}
                  </div>
                  <div className="text-xs text-muted-foreground">{user.email}</div>
                </TableCell>
                <TableCell>
                  {self ? (
                    <span className="text-sm">{roleName}</span>
                  ) : (
                    <ActionForm action={setRoleAction.bind(null, user.id)} submitLabel="Set" submitVariant="outline" inline>
                      <SelectField label="Role" name="role" defaultValue={roleKey ?? "viewer"} options={roleRows.map((r) => ({ value: r.key, label: r.name }))} />
                    </ActionForm>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={user.status} />
                </TableCell>
                <TableCell className="font-mono text-sm">{timeAgo(user.lastLoginAt)}</TableCell>
                <TableCell className="text-right">
                  {!self &&
                    (user.status === "active" ? (
                      <ActionForm
                        action={setUserStatusAction.bind(null, user.id, "disabled")}
                        submitLabel="Revoke access"
                        submitVariant="destructive"
                        confirm={`Revoke ${user.displayName}'s access? They will be signed out immediately.`}
                      />
                    ) : (
                      <ActionForm action={setUserStatusAction.bind(null, user.id, "active")} submitLabel="Restore access" submitVariant="outline" />
                    ))}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <Card className="mt-8 max-w-xl">
        <CardHeader>
          <CardTitle>Add a person</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={addUserAction} submitLabel="Add person" resetOnSuccess>
            <TextField label="Name" name="displayName" required />
            <TextField label="Email" name="email" type="email" required />
            <SelectField label="Role" name="role" defaultValue="viewer" options={roleOptions} />
            <TextField label="Initial password" name="password" type="password" autoComplete="new-password" minLength={12} required />
          </ActionForm>
        </CardContent>
      </Card>
    </>
  );
}
