import { changeRef, incidentRef, listChanges, listIncidents, type ChangeStatus } from "@moss/core";
import { agents, assets } from "@moss/db";
import { and, asc, eq, ne } from "drizzle-orm";
import Link from "next/link";
import { Pill, StatusBadge } from "@/components/badges";
import { FormDialog } from "@/components/form-dialog";
import { Empty, PageHeader, timeAgo, NoPermission } from "@/components/page";
import { SortableHead } from "@/components/sortable-head";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { readSort, sortRows } from "@/lib/sort";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { nameLookup } from "@/server/people";
import { plannableTools } from "@/server/tool-catalog";
import { ChangesBoard } from "./board";
import { RaiseChangeForm } from "./raise-change-form";
import { workingAgents } from "@/server/people";

/** What the "Raise a change" form offers: agents to carry it out, open incidents, assets and tools. */
async function raiseOptions(orgId: string) {
  const [agentRows, incidentRows, assetRows, tools] = await Promise.all([
    db().select({ id: agents.id, name: agents.name, title: agents.title }).from(agents).where(and(eq(agents.orgId, orgId), eq(agents.status, "active"), workingAgents)).orderBy(asc(agents.name)),
    listIncidents(db(), orgId, { status: ["new", "in_progress", "on_hold"], limit: 100 }),
    db().select({ id: assets.id, name: assets.name, ip: assets.primaryIp }).from(assets).where(and(eq(assets.orgId, orgId), ne(assets.status, "retired"))).orderBy(asc(assets.name)).limit(500),
    plannableTools(orgId),
  ]);
  return {
    agents: agentRows.map((a) => ({ value: a.id, label: `${a.name} (${a.title})` })),
    incidents: incidentRows.map((i) => ({ value: i.id, label: `${incidentRef(i.number)}: ${i.title}` })),
    assets: assetRows.map((a) => ({ value: a.id, label: a.ip ? `${a.name} (${a.ip})` : a.name })),
    tools,
  };
}

export const metadata = { title: "Changes" };

const VIEWS: Record<string, { label: string; status?: ChangeStatus[] }> = {
  pending: { label: "Needs approval", status: ["submitted"] },
  active: { label: "In flight", status: ["approved", "in_progress", "verifying"] },
  all: { label: "All" },
};

const RISK_TONE = { low: "green", medium: "amber", high: "red" } as const;

export default async function ChangesPage({ searchParams }: PageProps<"/changes">) {
  const user = await requireUser();
  if (!user.permissions.has("changes.read")) return <NoPermission />;
  const sp = await searchParams;
  const v = sp.view;
  const view = typeof v === "string" && v in VIEWS ? v : "pending";
  const board = sp.layout === "board";
  const canRaise = user.permissions.has("changes.create");
  const [unsorted, name, raise] = await Promise.all([
    listChanges(db(), user.orgId, { status: board ? undefined : VIEWS[view]!.status, limit: 200 }),
    nameLookup(user.orgId),
    canRaise ? raiseOptions(user.orgId) : null,
  ]);
  const sort = readSort(sp, ["ref", "title", "type", "risk", "status", "requested"] as const);
  const rows = sortRows(unsorted, sort, {
    ref: (c) => c.number,
    title: (c) => c.title,
    type: (c) => c.type,
    risk: (c) => ({ low: 1, medium: 2, high: 3 })[c.risk],
    status: (c) => c.status,
    requested: (c) => c.createdAt,
  });
  const head = (label: string, key: string) => <SortableHead label={label} sortKey={key} state={sort} path="/changes" sp={sp} />;

  return (
    <>
      <PageHeader
        title="Changes"
        description="Every change to a system goes through a change request. Agents plan; you approve."
        actions={
          raise && (
            <FormDialog
              label="Raise a change"
              title="Raise a change"
              description="It's submitted for approval. An agent carries it out by running exactly the tool calls you list, or a person does it by hand and records the result."
              wide
            >
              <RaiseChangeForm {...raise} />
            </FormDialog>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex gap-1" aria-label="Change views">
          {!board &&
            Object.entries(VIEWS).map(([key, { label }]) => (
            <Link
              key={key}
              href={`/changes?view=${key}`}
              aria-current={key === view ? "page" : undefined}
              className={cn("rounded-md px-3 py-1.5 text-sm", key === view ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60")}
            >
              {label}
            </Link>
          ))}
        </nav>
        <nav className="flex border-2" aria-label="Layout">
          {[
            ["List", `/changes?view=${view}`, !board],
            ["Board", "/changes?layout=board", board],
          ].map(([label, href, current]) => (
            <Link
              key={String(label)}
              href={String(href)}
              aria-current={current ? "page" : undefined}
              className={cn("px-3 py-1.5 text-sm", current ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60")}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
      {board ? (
        <ChangesBoard
          canApprove={user.permissions.has("changes.approve")}
          cards={unsorted
            // Finished changes stay on the board for 30 days.
            .filter((c) => !["succeeded", "failed", "rolled_back", "rejected", "cancelled"].includes(c.status) || c.updatedAt.getTime() >= Date.now() - 30 * 86_400_000)
            .map((c) => ({
              id: c.id,
              ref: changeRef(c.number),
              title: c.title,
              status: c.status,
              risk: c.risk,
              type: c.type,
              requester: name(c.requestedByAgentId ?? c.requestedByUserId),
              updated: timeAgo(c.updatedAt),
              postReviewRequired: c.postReviewRequired,
            }))}
        />
      ) : rows.length === 0 ? (
        <Empty>{view === "pending" ? "Nothing waiting for approval." : "No changes here."}</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {head("Ref", "ref")}
              {head("Title", "title")}
              {head("Type", "type")}
              {head("Risk", "risk")}
              {head("Status", "status")}
              {head("Requested", "requested")}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono text-xs">
                  <Link href={`/changes/${c.id}`} className="hover:underline">
                    {changeRef(c.number)}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link href={`/changes/${c.id}`} className="font-medium hover:underline">
                    {c.title}
                  </Link>
                  {c.postReviewRequired && <Pill tone="orange" className="ml-2">review needed</Pill>}
                </TableCell>
                <TableCell className="text-sm">{c.type}</TableCell>
                <TableCell>
                  <Pill tone={RISK_TONE[c.risk]}>{c.risk}</Pill>
                </TableCell>
                <TableCell>
                  <StatusBadge status={c.status} />
                </TableCell>
                <TableCell className="text-sm">
                  {name(c.requestedByAgentId ?? c.requestedByUserId)} · <span className="font-mono">{timeAgo(c.createdAt)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
