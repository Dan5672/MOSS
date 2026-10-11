import { changeRef, getIncident, incidentRef } from "@moss/core";
import { changeRequests } from "@moss/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Pill, PriorityBadge, StatusBadge } from "@/components/badges";
import { SelectField, TextAreaField } from "@/components/field";
import { Empty, PageHeader, Section, timeAgo, NoPermission } from "@/components/page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CommentText, MentionTextarea } from "@/components/mention-textarea";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { assigneeOptions, mentionOptions, nameLookup } from "@/server/people";
import { commentAction, updateIncidentAction } from "../actions";

export default async function IncidentPage({ params }: PageProps<"/incidents/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  if (!user.permissions.has("incidents.read")) return <NoPermission />;
  const inc = await getIncident(db(), user.orgId, id);
  if (!inc) notFound();
  const [changes, options, name, mentions] = await Promise.all([
    db().select().from(changeRequests).where(eq(changeRequests.incidentId, id)).orderBy(desc(changeRequests.createdAt)),
    assigneeOptions(user.orgId),
    nameLookup(user.orgId),
    mentionOptions(user.orgId),
  ]);
  const canManage = user.permissions.has("incidents.manage");
  const assignee = inc.assignedAgentId ? `agent:${inc.assignedAgentId}` : inc.assignedUserId ? `user:${inc.assignedUserId}` : "";

  return (
    <>
      <PageHeader
        title={`${incidentRef(inc.number)}: ${inc.title}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <PriorityBadge priority={inc.priority} /> <StatusBadge status={inc.status} /> {inc.type.replace("_", "/")} · raised by{" "}
            {name(inc.raisedByAgentId ?? inc.raisedByUserId)} <span className="font-mono">{timeAgo(inc.createdAt)}</span>
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {inc.description && <p className="px-frame p-4 text-sm whitespace-pre-wrap">{inc.description}</p>}

          {inc.assets.length > 0 && (
            <Section title="Affected assets">
              <div className="flex flex-wrap gap-2">
                {inc.assets.map((a) => (
                  <Link key={a.id} href={`/assets/${a.id}`} className="border-2 px-2 py-1 font-mono text-sm hover:bg-accent">
                    {a.name} <span className="font-mono text-xs text-muted-foreground">{a.ip}</span>
                  </Link>
                ))}
              </div>
            </Section>
          )}

          {changes.length > 0 && (
            <Section title="Changes">
              <ul className="divide-y-2 px-frame text-sm">
                {changes.map((c) => (
                  <li key={c.id}>
                    <Link href={`/changes/${c.id}`} className="flex items-center gap-3 p-3 hover:bg-accent">
                      <span className="font-mono text-xs">{changeRef(c.number)}</span> <StatusBadge status={c.status} /> {c.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Timeline">
            {inc.comments.length === 0 ? (
              <Empty>No comments yet.</Empty>
            ) : (
              <ol className="space-y-3">
                {inc.comments.map((c) => (
                  <li key={c.id} className="px-frame p-3 text-sm">
                    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{name(c.authorAgentId ?? c.authorUserId)}</span>
                      {c.authorAgentId && <Pill tone="blue">agent</Pill>}
                      <span className="font-mono">{timeAgo(c.createdAt)}</span>
                    </div>
                    <CommentText text={c.body} names={mentions.map((m) => m.name)} />
                  </li>
                ))}
              </ol>
            )}
            {canManage && (
              <ActionForm action={commentAction.bind(null, id)} submitLabel="Add comment" resetOnSuccess>
                <MentionTextarea label="Comment" name="body" rows={3} options={mentions} required />
              </ActionForm>
            )}
          </Section>
        </div>

        {canManage && (
          <Card>
            <CardHeader>
              <CardTitle>Update</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm action={updateIncidentAction.bind(null, id)} submitLabel="Save">
                <SelectField
                  label="Status"
                  name="status"
                  defaultValue={inc.status}
                  options={["new", "in_progress", "on_hold", "resolved", "closed"].map((s) => ({ value: s, label: s.replace("_", " ") }))}
                />
                <SelectField label="Priority" name="priority" defaultValue={inc.priority} options={["P1", "P2", "P3", "P4"].map((p) => ({ value: p, label: p }))} />
                <SelectField label="Assignee" name="assignee" defaultValue={assignee} options={options} />
                <TextAreaField label="Note (optional)" name="note" rows={2} />
              </ActionForm>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
