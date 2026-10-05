import { incidentRef, listIncidents } from "@moss/core";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { PriorityBadge, StatusBadge } from "@/components/badges";
import { SelectField, TextAreaField, TextField } from "@/components/field";
import { Empty, PageHeader, timeAgo, NoPermission } from "@/components/page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { assigneeOptions, nameLookup } from "@/server/people";
import { createIncidentAction } from "./actions";

export const metadata = { title: "Incidents" };

export default async function IncidentsPage({ searchParams }: PageProps<"/incidents">) {
  const user = await requireUser();
  if (!user.permissions.has("incidents.read")) return <NoPermission />;
  const showAll = (await searchParams).all === "1";
  const [rows, options, name] = await Promise.all([
    listIncidents(db(), user.orgId, { status: showAll ? undefined : ["new", "in_progress", "on_hold"], limit: 200 }),
    assigneeOptions(user.orgId),
    nameLookup(user.orgId),
  ]);

  return (
    <>
      <PageHeader
        title="Incidents"
        description="Break/fix, security and requests, raised by you or your agents."
        actions={
          <Link href={showAll ? "/incidents" : "/incidents?all=1"} className="text-sm underline">
            {showAll ? "Show open only" : "Show all"}
          </Link>
        }
      />
      {rows.length === 0 ? (
        <Empty>{showAll ? "No incidents yet." : "No open incidents."}</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ref</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Assignee</TableHead>
              <TableHead>Opened</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((i) => (
              <TableRow key={i.id}>
                <TableCell className="font-mono text-xs">{incidentRef(i.number)}</TableCell>
                <TableCell>
                  <PriorityBadge priority={i.priority} />
                </TableCell>
                <TableCell>
                  <Link href={`/incidents/${i.id}`} className="font-medium hover:underline">
                    {i.title}
                  </Link>
                  <div className="text-xs text-muted-foreground">{i.type.replace("_", "/")}</div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={i.status} />
                </TableCell>
                <TableCell className="text-sm">{name(i.assignedAgentId ?? i.assignedUserId, "—")}</TableCell>
                <TableCell className="whitespace-nowrap font-mono text-sm">{timeAgo(i.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {user.permissions.has("incidents.manage") && (
        <Card className="mt-8 max-w-2xl">
          <CardHeader>
            <CardTitle>Raise an incident</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={createIncidentAction} submitLabel="Raise incident">
              <TextField label="Title" name="title" placeholder="Wi-Fi drops every evening" required />
              <TextAreaField label="Description" name="description" rows={3} />
              <div className="grid gap-2 sm:grid-cols-3">
                <SelectField
                  label="Type"
                  name="type"
                  options={[
                    { value: "break_fix", label: "Something is broken" },
                    { value: "security", label: "Security" },
                    { value: "request", label: "Request" },
                  ]}
                />
                <SelectField
                  label="Priority"
                  name="priority"
                  defaultValue="P3"
                  options={[
                    { value: "P1", label: "P1 — critical" },
                    { value: "P2", label: "P2 — major" },
                    { value: "P3", label: "P3 — minor" },
                    { value: "P4", label: "P4 — low" },
                  ]}
                />
                <SelectField label="Assign to" name="assignee" options={options} hint="Assigning an agent starts work immediately." />
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      )}
    </>
  );
}
