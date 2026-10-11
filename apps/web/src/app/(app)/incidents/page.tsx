import { incidentRef, listIncidents } from "@moss/core";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { PriorityBadge, StatusBadge } from "@/components/badges";
import { SelectField, TextAreaField, TextField } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Empty, PageHeader, timeAgo, NoPermission } from "@/components/page";
import { SortableHead } from "@/components/sortable-head";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { readSort, sortRows } from "@/lib/sort";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { assigneeOptions, nameLookup } from "@/server/people";
import { createIncidentAction } from "./actions";

export const metadata = { title: "Incidents" };

export default async function IncidentsPage({ searchParams }: PageProps<"/incidents">) {
  const user = await requireUser();
  if (!user.permissions.has("incidents.read")) return <NoPermission />;
  const sp = await searchParams;
  const showAll = sp.all === "1";
  const [unsorted, options, name] = await Promise.all([
    listIncidents(db(), user.orgId, { status: showAll ? undefined : ["new", "in_progress", "on_hold"], limit: 200 }),
    assigneeOptions(user.orgId),
    nameLookup(user.orgId),
  ]);
  const sort = readSort(sp, ["ref", "priority", "title", "status", "assignee", "opened"] as const);
  const rows = sortRows(unsorted, sort, {
    ref: (i) => i.number,
    priority: (i) => i.priority,
    title: (i) => i.title,
    status: (i) => i.status,
    assignee: (i) => name(i.assignedAgentId ?? i.assignedUserId, ""),
    opened: (i) => i.createdAt,
  });
  const head = (label: string, key: string) => <SortableHead label={label} sortKey={key} state={sort} path="/incidents" sp={sp} />;

  return (
    <>
      <PageHeader
        title="Incidents"
        description="Break/fix, security and requests, raised by you or your agents."
        actions={
          <div className="flex flex-wrap items-center gap-4">
            <Link href={showAll ? "/incidents" : "/incidents?all=1"} className="text-sm underline">
              {showAll ? "Show open only" : "Show all"}
            </Link>
            {user.permissions.has("incidents.manage") && (
              <FormDialog
                label="Raise an incident"
                title="Raise an incident"
                description="Describe what's wrong. Assigning an agent starts work straight away."
              >
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
              </FormDialog>
            )}
          </div>
        }
      />
      {rows.length === 0 ? (
        <Empty>{showAll ? "No incidents yet." : "No open incidents."}</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {head("Ref", "ref")}
              {head("Priority", "priority")}
              {head("Title", "title")}
              {head("Status", "status")}
              {head("Assignee", "assignee")}
              {head("Opened", "opened")}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((i) => (
              <TableRow key={i.id}>
                <TableCell className="font-mono text-xs">
                  <Link href={`/incidents/${i.id}`} className="hover:underline">
                    {incidentRef(i.number)}
                  </Link>
                </TableCell>
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
    </>
  );
}
