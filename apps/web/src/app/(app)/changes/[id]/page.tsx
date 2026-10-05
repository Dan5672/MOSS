import { changeRef, getChange, incidentRef } from "@moss/core";
import { incidents } from "@moss/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Pill, StatusBadge } from "@/components/badges";
import { TextAreaField } from "@/components/field";
import { PageHeader, Section, timeAgo, NoPermission } from "@/components/page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { nameLookup } from "@/server/people";
import { approveAction, cancelAction, changeCommentAction, rejectAction } from "../actions";

function Calls({ calls }: { calls: { tool: string; args: Record<string, unknown> }[] }) {
  if (calls.length === 0) return <p className="text-sm text-muted-foreground">None.</p>;
  return (
    <ol className="space-y-2">
      {calls.map((c, i) => (
        <li key={i} className="px-frame p-3">
          <div className="text-sm">
            <span className="text-muted-foreground">{i + 1}.</span> <span className="font-mono font-medium">{c.tool}</span>
          </div>
          <pre className="mt-1 overflow-auto text-xs whitespace-pre-wrap text-muted-foreground">{JSON.stringify(c.args, null, 2)}</pre>
        </li>
      ))}
    </ol>
  );
}

export default async function ChangePage({ params }: PageProps<"/changes/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  if (!user.permissions.has("changes.read")) return <NoPermission />;
  const change = await getChange(db(), user.orgId, id);
  if (!change) notFound();
  const [name, [incident]] = await Promise.all([
    nameLookup(user.orgId),
    change.incidentId ? db().select().from(incidents).where(eq(incidents.id, change.incidentId)) : Promise.resolve([]),
  ]);
  const canApprove = user.permissions.has("changes.approve") && change.status === "submitted";
  const canComment = user.permissions.has("changes.create");
  const cancellable = user.permissions.has("changes.create") && ["draft", "submitted", "approved"].includes(change.status);

  return (
    <>
      <PageHeader
        title={`${changeRef(change.number)}: ${change.title}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={change.status} /> <Pill>{change.type}</Pill> <Pill tone={change.risk === "high" ? "red" : change.risk === "medium" ? "amber" : "green"}>{change.risk} risk</Pill>
            requested by {name(change.requestedByAgentId ?? change.requestedByUserId)} <span className="font-mono">{timeAgo(change.createdAt)}</span>
            {incident && (
              <>
                · for{" "}
                <Link href={`/incidents/${incident.id}`} className="underline">
                  <span className="font-mono">{incidentRef(incident.number)}</span>
                </Link>
              </>
            )}
          </span>
        }
        actions={cancellable && <ActionForm action={cancelAction.bind(null, id)} submitLabel="Cancel change" submitVariant="outline" confirm="Cancel this change?" />}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <p className="px-frame p-4 text-sm whitespace-pre-wrap">{change.description}</p>
          {(change.windowStart || change.windowEnd) && (
            <p className="text-sm">
              Window: <span className="font-mono">{change.windowStart?.toLocaleString() ?? "now"} – {change.windowEnd?.toLocaleString() ?? "open"}</span>
            </p>
          )}
          <Section title="What will run">
            <p className="text-sm text-muted-foreground">These exact calls are the only ones the policy gate will allow for this change.</p>
            <Calls calls={change.plannedCalls} />
          </Section>
          <Section title="How it will be checked">
            <p className="text-sm whitespace-pre-wrap">{change.verificationPlan}</p>
          </Section>
          <Section title="Rollback">
            <p className="text-sm whitespace-pre-wrap">{change.rollbackPlan}</p>
            <Calls calls={change.rollbackCalls} />
          </Section>
          <Section title="Timeline">
            <ol className="space-y-2">
              {change.notes.map((n) => (
                <li key={n.id} className="px-frame p-3 text-sm">
                  <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <Pill tone={n.kind === "execution" ? "blue" : "gray"}>{n.kind}</Pill>
                    <span className="font-medium text-foreground">{name(n.authorAgentId ?? n.authorUserId)}</span>
                    <span className="font-mono">{timeAgo(n.createdAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap">{n.body}</p>
                </li>
              ))}
            </ol>
            {canComment && (
              <ActionForm action={changeCommentAction.bind(null, id)} submitLabel="Add comment" resetOnSuccess>
                <TextAreaField label="Comment" name="body" rows={2} required />
              </ActionForm>
            )}
          </Section>
        </div>

        {canApprove && (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Decision</CardTitle>
              <CardDescription>Approving lets the requesting agent run exactly the calls listed here, and nothing else.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <ActionForm action={approveAction.bind(null, id)} submitLabel="Approve">
                <TextAreaField label="Comment (optional)" name="comment" rows={2} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="force" /> Approve even if it conflicts with another change
                </label>
              </ActionForm>
              <ActionForm action={rejectAction.bind(null, id)} submitLabel="Reject" submitVariant="destructive">
                <TextAreaField label="Reason" name="comment" rows={2} required />
              </ActionForm>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
