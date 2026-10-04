import { verifyAuditLog } from "@moss/core";
import { auditLog } from "@moss/db";
import { and, desc, eq, like } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Pill } from "@/components/badges";
import { PageHeader, NoPermission } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type ActionState } from "@/server/action";
import { requirePermission, requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { nameLookup } from "@/server/people";

export const metadata = { title: "Audit log" };

async function verifyAction(_: ActionState): Promise<ActionState> {
  "use server";
  const user = await requirePermission("audit.read");
  const broken = await verifyAuditLog(db(), user.orgId);
  return broken === null
    ? { ok: true, message: "The audit log is intact: every entry matches its hash chain." }
    : { error: `The audit log has been altered: entry #${broken} does not match the hash chain.` };
}

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const user = await requireUser();
  if (!user.permissions.has("audit.read")) return <NoPermission />;
  const a = (await searchParams).action;
  const filter = typeof a === "string" ? a.replace(/[%_\\]/g, "").slice(0, 60) : "";
  const [rows, name] = await Promise.all([
    db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, user.orgId), filter ? like(auditLog.action, `${filter}%`) : undefined))
      .orderBy(desc(auditLog.id))
      .limit(300),
    nameLookup(user.orgId),
  ]);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="An append-only, hash-chained record of every action by people and agents. Tampering with any entry breaks the chain."
        actions={<ActionForm action={verifyAction} submitLabel="Verify integrity" submitVariant="outline" />}
      />
      <form className="mb-4 flex gap-2" role="search">
        <Input name="action" defaultValue={filter} placeholder="Filter by action, e.g. tool. or change." aria-label="Filter by action" className="max-w-sm" />
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>When</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="font-mono text-xs text-muted-foreground">{e.id}</TableCell>
              <TableCell className="whitespace-nowrap text-xs">{e.createdAt.toLocaleString()}</TableCell>
              <TableCell className="text-sm">
                <Pill tone={e.actorType === "agent" ? "blue" : e.actorType === "user" ? "gray" : "amber"}>{e.actorType}</Pill>{" "}
                {e.actorType !== "system" && name(e.actorId)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {e.action}
                {e.action === "tool.denied" && <Pill tone="red" className="ml-2">denied</Pill>}
              </TableCell>
              <TableCell className="max-w-md">
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {e.targetType ? `${e.targetType} ${e.targetId ?? ""}` : "details"}
                  </summary>
                  <pre className="mt-1 max-h-60 overflow-auto text-xs whitespace-pre-wrap">{JSON.stringify(e.details, null, 2)}</pre>
                </details>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
