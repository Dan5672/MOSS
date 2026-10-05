import { changeRef, listChanges, type ChangeStatus } from "@moss/core";
import Link from "next/link";
import { Pill, StatusBadge } from "@/components/badges";
import { Empty, PageHeader, timeAgo, NoPermission } from "@/components/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { nameLookup } from "@/server/people";

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
  const v = (await searchParams).view;
  const view = typeof v === "string" && v in VIEWS ? v : "pending";
  const [rows, name] = await Promise.all([listChanges(db(), user.orgId, { status: VIEWS[view]!.status, limit: 200 }), nameLookup(user.orgId)]);

  return (
    <>
      <PageHeader title="Changes" description="Every change to a system goes through a change request. Agents plan; you approve." />
      <nav className="mb-4 flex gap-1" aria-label="Change views">
        {Object.entries(VIEWS).map(([key, { label }]) => (
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
      {rows.length === 0 ? (
        <Empty>{view === "pending" ? "Nothing waiting for approval." : "No changes here."}</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ref</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Requested</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono text-xs">{changeRef(c.number)}</TableCell>
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
