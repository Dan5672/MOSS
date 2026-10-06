import { searchNotes } from "@moss/core";
import { agents, users } from "@moss/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Pill } from "@/components/badges";
import { Empty, NoPermission, PageHeader, Section, timeAgo } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { AgentsTabs } from "../tabs";
import { addNoteAction, deleteNoteAction, updateNoteAction } from "./actions";
import { NoteFields } from "./note-fields";

export const metadata = { title: "Knowledge base" };

export default async function KnowledgePage({ searchParams }: PageProps<"/agents/knowledge">) {
  const user = await requireUser();
  if (!user.permissions.has("knowledge.read")) return <NoPermission />;
  const q = typeof (await searchParams).q === "string" ? ((await searchParams).q as string) : "";
  const [notes, agentRows, userRows] = await Promise.all([
    searchNotes(db(), user.orgId, { query: q, limit: 100 }),
    db().select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.orgId, user.orgId)),
    db().select({ id: users.id, name: users.displayName }).from(users).where(eq(users.orgId, user.orgId)),
  ]);
  const who = (agentId: string | null, userId: string | null) =>
    agentRows.find((a) => a.id === agentId)?.name ?? userRows.find((u) => u.id === userId)?.name ?? "someone";
  const canManage = user.permissions.has("knowledge.manage");

  return (
    <>
      <PageHeader
        title="Agents"
        description="Facts the team has written down. Agents with the Team Memory skill check it before raising findings and add to it as they learn."
      />
      <AgentsTabs current="/agents/knowledge" />

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <Section title="Knowledge base">
          <form className="flex gap-2" role="search">
            <Input name="q" defaultValue={q} placeholder="Search notes" aria-label="Search notes" className="font-mono" />
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
          {notes.length === 0 ? (
            <Empty>{q ? `Nothing matches "${q}".` : "No notes yet. Agents add them as they learn, or add one yourself."}</Empty>
          ) : (
            <ul className="grid gap-3">
              {notes.map((n) => (
                <li key={n.id} className="px-frame grid gap-2 bg-card p-4 text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h3 className="font-semibold">{n.title}</h3>
                    {n.subject && <span className="font-mono text-xs text-signal">{n.subject}</span>}
                    {n.tags.map((t) => (
                      <Pill key={t}>{t}</Pill>
                    ))}
                  </div>
                  {/* Plain text: agent-written notes can quote untrusted network data. */}
                  <p className="whitespace-pre-wrap text-muted-foreground">{n.body}</p>
                  <p className="font-mono text-xs text-dim">
                    {n.updatedByAgentId ? (
                      <Link href={`/agents/${n.updatedByAgentId}`} className="hover:underline">
                        {who(n.updatedByAgentId, null)}
                      </Link>
                    ) : (
                      who(null, n.updatedByUserId)
                    )}{" "}
                    · {timeAgo(n.updatedAt)}
                  </p>
                  {canManage && (
                    <div className="flex flex-wrap items-start gap-2">
                      <ActionForm action={deleteNoteAction.bind(null, n.id)} submitLabel="Delete" submitVariant="outline" confirm={`Delete the note "${n.title}"?`} />
                      <details className="basis-full">
                        <summary className="cursor-pointer text-xs text-muted-foreground">Edit</summary>
                        <ActionForm action={updateNoteAction.bind(null, n.id)} submitLabel="Save note" className="mt-3">
                          <NoteFields note={n} />
                        </ActionForm>
                      </details>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {canManage && (
          <Section title="Add a note">
            <div className="px-frame bg-card p-4">
              <ActionForm action={addNoteAction} submitLabel="Add note" resetOnSuccess>
                <NoteFields />
              </ActionForm>
            </div>
          </Section>
        )}
      </div>
    </>
  );
}
