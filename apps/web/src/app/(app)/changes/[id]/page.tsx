import { changeRef, getChange, incidentRef, isManualChange } from "@moss/core";
import { incidents, secrets } from "@moss/db";
import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Pill, StatusBadge } from "@/components/badges";
import { SelectField, TextAreaField } from "@/components/field";
import { PageHeader, Section, timeAgo, NoPermission } from "@/components/page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CommentText, MentionTextarea } from "@/components/mention-textarea";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { mentionOptions, nameLookup } from "@/server/people";
import { approveAction, cancelAction, changeCommentAction, recordResultAction, rejectAction } from "../actions";

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
  const [name, [incident], mentions, secretRows] = await Promise.all([
    nameLookup(user.orgId),
    change.incidentId ? db().select().from(incidents).where(eq(incidents.id, change.incidentId)) : Promise.resolve([]),
    mentionOptions(user.orgId),
    change.accessGrant?.secretIds.length
      ? db().select({ name: secrets.name }).from(secrets).where(and(eq(secrets.orgId, user.orgId), inArray(secrets.id, change.accessGrant.secretIds)))
      : Promise.resolve([]),
  ]);
  const secretNames = secretRows.map((r) => r.name);
  const canApprove = user.permissions.has("changes.approve") && change.status === "submitted";
  const byHand = isManualChange(change);
  const canRecord = byHand && user.permissions.has("changes.create") && ["approved", "in_progress", "verifying"].includes(change.status);
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
          {change.description && <p className="px-frame p-4 text-sm whitespace-pre-wrap">{change.description}</p>}
          {(change.windowStart || change.windowEnd) && (
            <p className="text-sm">
              Window: <span className="font-mono">{change.windowStart?.toLocaleString() ?? "now"} – {change.windowEnd?.toLocaleString() ?? "open"}</span>
            </p>
          )}
          {change.accessGrant ? (
            <Section title="Access requested">
              <p className="text-sm text-muted-foreground">Nothing runs. Approving gives {name(change.requestedByAgentId)} exactly this, and closes the change.</p>
              <ul className="flex flex-wrap gap-2" aria-label="Access requested">
                {change.accessGrant.tools.map((t) => (
                  <li key={t}>
                    <Pill tone="blue">{t}</Pill>
                  </li>
                ))}
                {secretNames.map((n) => (
                  <li key={n}>
                    <Pill tone="amber">secret:{n}</Pill>
                  </li>
                ))}
              </ul>
            </Section>
          ) : byHand ? (
            <Section title="Carried out by hand">
              <p className="text-sm text-muted-foreground">A person makes this change and records the result here. No agent or tool runs for it.</p>
            </Section>
          ) : (
            <Section title="What will run">
              <p className="text-sm text-muted-foreground">
                {change.requestedByUserId && change.requestedByAgentId ? `${name(change.requestedByAgentId)} runs these once it's approved. ` : ""}
                These exact calls are the only ones the policy gate will allow for this change.
              </p>
              <Calls calls={change.plannedCalls} />
            </Section>
          )}
          {!change.accessGrant && (
            <Section title="How it will be checked">
              <p className="text-sm whitespace-pre-wrap">{change.verificationPlan || <span className="text-muted-foreground">Not given.</span>}</p>
            </Section>
          )}
          <Section title="Rollback">
            <p className="text-sm whitespace-pre-wrap">{change.rollbackPlan || <span className="text-muted-foreground">Not given.</span>}</p>
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
                  <CommentText text={n.body} names={mentions.map((m) => m.name)} />
                </li>
              ))}
            </ol>
            {canComment && (
              <ActionForm action={changeCommentAction.bind(null, id)} submitLabel="Add comment" resetOnSuccess>
                <MentionTextarea label="Comment" name="body" rows={2} options={mentions} required />
              </ActionForm>
            )}
          </Section>
        </div>

        {canRecord && (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Record the result</CardTitle>
              <CardDescription>Once you&apos;ve made the change, say how it went. This closes the change.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={recordResultAction.bind(null, id)} submitLabel="Record result">
                <SelectField
                  label="Outcome"
                  name="outcome"
                  options={[
                    { value: "succeeded", label: "It worked" },
                    { value: "failed", label: "It failed" },
                  ]}
                />
                <TextAreaField label="What happened" name="notes" rows={3} required />
              </ActionForm>
            </CardContent>
          </Card>
        )}

        {canApprove && (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Decision</CardTitle>
              <CardDescription>
                {change.accessGrant
                  ? "Approving gives the agent the access listed here, straight away."
                  : byHand
                    ? "Approving lets the person go ahead and make this change."
                    : "Approving lets the agent run exactly the calls listed here, and nothing else."}
              </CardDescription>
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
