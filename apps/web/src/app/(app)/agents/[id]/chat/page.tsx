import { agents, chatMessages, chatThreads } from "@moss/db";
import { and, asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/badges";
import { TextAreaField } from "@/components/field";
import { Empty, NoPermission, PageHeader, timeAgo } from "@/components/page";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { newConversationAction, sendChatAction } from "./actions";
import { AutoRefresh } from "./auto-refresh";

export const metadata = { title: "Chat" };

export default async function ChatPage({ params }: PageProps<"/agents/[id]/chat">) {
  const { id } = await params;
  const user = await requireUser();
  if (!user.permissions.has("agents.chat")) return <NoPermission />;
  const [agent] = await db().select().from(agents).where(and(eq(agents.id, id), eq(agents.orgId, user.orgId)));
  if (!agent) notFound();

  const [thread] = await db()
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.agentId, id), eq(chatThreads.userId, user.id)))
    .orderBy(desc(chatThreads.createdAt))
    .limit(1);
  const messages = thread ? await db().select().from(chatMessages).where(eq(chatMessages.threadId, thread.id)).orderBy(asc(chatMessages.createdAt)) : [];
  const waiting = messages.at(-1)?.role === "user";

  return (
    <>
      <PageHeader
        title={`Chat with ${agent.name}`}
        description={
          <span className="flex items-center gap-2">
            <Link href={`/agents/${id}`} className="hover:underline">
              {agent.title}
            </Link>
            <StatusBadge status={agent.status} />
          </span>
        }
        actions={messages.length > 0 && <ActionForm action={newConversationAction.bind(null, id)} submitLabel="New conversation" submitVariant="outline" />}
      />

      <div className="mx-auto max-w-3xl space-y-4">
        {messages.length === 0 ? (
          <Empty>
            Ask {agent.name} a question or give them a job. They work with their skills&apos; tools, and anything that changes a system still
            needs your approval as a change request.
          </Empty>
        ) : (
          <ol className="space-y-3" aria-label="Conversation">
            {messages.map((m) => (
              <li key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg border px-4 py-3 text-sm",
                    m.role === "user" ? "bg-primary text-primary-foreground" : "bg-card",
                    m.status && m.status !== "succeeded" && "border-destructive/50",
                  )}
                >
                  {/* Plain text only: agent replies can quote untrusted network data. */}
                  <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  <p className={cn("mt-2 text-xs", m.role === "user" ? "text-primary-foreground/70" : "text-muted-foreground")}>
                    {m.role === "user" ? "You" : agent.name} · {timeAgo(m.createdAt)}
                    {m.status && m.status !== "succeeded" && ` · run ${m.status}`}
                    {m.runId && (
                      <>
                        {" · "}
                        <Link href={`/runs/${m.runId}`} className="underline">
                          see what {agent.name} did
                        </Link>
                      </>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}

        {waiting && (
          <p role="status" className="text-sm text-muted-foreground">
            {agent.name} is working on a reply…
            <AutoRefresh />
          </p>
        )}

        {agent.status === "active" ? (
          <ActionForm action={sendChatAction.bind(null, id)} submitLabel="Send" resetOnSuccess>
            <TextAreaField label="Message" name="message" rows={3} maxLength={4000} required placeholder={`What's on the network, ${agent.name}?`} />
          </ActionForm>
        ) : (
          <Empty>
            {agent.name} is {agent.status} and can&apos;t reply.
          </Empty>
        )}
      </div>
    </>
  );
}
