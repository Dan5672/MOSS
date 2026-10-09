import { GENERAL_CHANNEL, getConversation, markRead, mentionables } from "@moss/core";
import { agentRuns } from "@moss/db";
import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Pill } from "@/components/badges";
import { SelectField } from "@/components/field";
import { LiveRefresh } from "@/components/live-refresh";
import { MascotSvg } from "@/components/mascot-svg";
import { CommentText, MentionTextarea } from "@/components/mention-textarea";
import { timeAgo } from "@/components/page";
import { agentGlow, agentMascot } from "@/lib/agent-look";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { addMemberAction, leaveChannelAction, sendMessageAction } from "../actions";
import { ChatScroller } from "../chat-scroller";

export const metadata = { title: "Chat" };

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}

export default async function ConversationPage({ params }: PageProps<"/chat/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const conv = await getConversation(db(), user.orgId, id, user.id).catch(() => null);
  if (!conv) notFound();
  await markRead(db(), id, user.id);
  const agentMembers = conv.members.filter((m) => m.agentId);
  const [everyone, working] = await Promise.all([
    mentionables(db(), user.orgId),
    agentMembers.length
      ? db()
          .select({ agentId: agentRuns.agentId })
          .from(agentRuns)
          .where(and(eq(agentRuns.trigger, "chat"), eq(agentRuns.triggerRef, id), eq(agentRuns.status, "running"), inArray(agentRuns.agentId, agentMembers.map((m) => m.agentId!))))
      : [],
  ]);
  const memberOf = (m: { authorUserId: string | null; authorAgentId: string | null }) =>
    conv.members.find((x) => (m.authorAgentId ? x.agentId === m.authorAgentId : x.userId === m.authorUserId));
  const nameOf = (m: { authorUserId: string | null; authorAgentId: string | null }) => {
    const x = memberOf(m);
    if (x) return (x.agentName ?? x.userName)!;
    return everyone.find((p) => p.id === (m.authorAgentId ?? m.authorUserId))?.name ?? (m.authorAgentId ? "An agent" : "Someone");
  };
  const other = conv.kind === "dm" ? conv.members.find((m) => m.userId !== user.id) : undefined;
  const title = conv.kind === "channel" ? `#${conv.name}` : (other?.agentName ?? other?.userName ?? "Direct message");
  const mentionOptions = everyone.map((m) => ({ name: m.name, kind: m.type === "agent" ? "agent" : "person" }));
  const names = everyone.map((m) => m.name);
  const notMembers = everyone.filter((p) => !conv.members.some((m) => m.userId === p.id || m.agentId === p.id));
  const typing = conv.members.filter((m) => m.agentId && working.some((w) => w.agentId === m.agentId));

  const description =
    conv.kind === "channel"
      ? (conv.topic ?? `A channel with ${conv.members.length} member${conv.members.length === 1 ? "" : "s"}. @mention an agent to ask it something.`)
      : other?.agentId
        ? `${other.agentTitle}. Replies come from runs you can follow in Activity.`
        : "A direct message.";

  return (
    <>
      <LiveRefresh everyMs={4000} />
      <header className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-3 border-b-2 pb-3">
        <div className="min-w-0">
          <h1 className="font-pixel text-[20px] leading-snug font-normal break-words text-ink dark:text-beige">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <details className="relative">
          <summary className="cursor-pointer border-2 px-3 py-1.5 font-mono text-xs">
            Members ({conv.members.length})
          </summary>
          <aside aria-label="Members" className="absolute right-0 z-20 mt-2 grid w-72 content-start gap-3 border-2 bg-card p-3 text-sm shadow-lg">
            <ul className="grid gap-1.5">
              {conv.members.map((m) => (
                <li key={m.agentId ?? m.userId} className="flex items-center gap-2">
                  {m.agentId ? (
                    <Link href={`/agents/${m.agentId}`} className="underline-offset-2 hover:underline">
                      {m.agentName}
                    </Link>
                  ) : (
                    <span>{m.userId === user.id ? `${m.userName} (you)` : m.userName}</span>
                  )}
                  {m.agentId && <span className="font-mono text-xs text-dim">agent</span>}
                </li>
              ))}
            </ul>
            {conv.kind === "channel" && (
              <>
                {notMembers.length > 0 && (
                  <ActionForm action={addMemberAction.bind(null, id)} submitLabel="Add" resetOnSuccess>
                    <SelectField
                      label="Add someone"
                      name="member"
                      options={[{ value: "", label: "Choose" }, ...notMembers.map((p) => ({ value: `${p.type}:${p.id}`, label: `${p.name}${p.type === "agent" ? " (agent)" : ""}` }))]}
                    />
                  </ActionForm>
                )}
                {conv.name !== GENERAL_CHANNEL && (
                  <ActionForm action={leaveChannelAction.bind(null, id)} submitLabel="Leave channel" submitVariant="outline" confirm={`Leave ${title}?`} />
                )}
              </>
            )}
          </aside>
        </details>
      </header>
      <ChatScroller count={conv.messages.length}>
        <ol aria-label="Messages" className="grid gap-3 pb-2">
          {conv.messages.length === 0 && <li className="text-sm text-muted-foreground">No messages yet. Say hello.</li>}
          {conv.messages.map((m) => {
            const x = memberOf(m);
            const failed = m.status === "failed" || m.status === "aborted";
            return (
              <li key={m.id} className="flex gap-3">
                <span aria-hidden className="mt-0.5 shrink-0">
                  {x?.agentId ? (
                    <MascotSvg variant={agentMascot({ mascot: x.mascot, templateKey: x.templateKey })} size={32} glow={agentGlow({ mascotGlow: x.mascotGlow, templateKey: x.templateKey })} />
                  ) : (
                    <span className="grid size-8 place-items-center bg-[#2b3a33] font-mono text-xs text-beige">{initials(nameOf(m))}</span>
                  )}
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{nameOf(m)}</span>
                    {m.authorAgentId && <Pill tone="blue">agent</Pill>}
                    <span className="font-mono text-xs text-dim">{timeAgo(m.createdAt)}</span>
                    {m.runId && (
                      <Link href={`/runs/${m.runId}`} className="text-xs text-muted-foreground underline">
                        {failed ? "run failed" : "how"}
                      </Link>
                    )}
                  </div>
                  <div className={failed ? "text-alarm" : undefined}>
                    <CommentText text={m.body} names={names} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </ChatScroller>
      <div className="shrink-0 border-t-2 pt-3">
        {typing.length > 0 && (
          <p role="status" className="mb-2 font-mono text-xs text-phosphor">
            {typing.map((t) => t.agentName).join(", ")} {typing.length === 1 ? "is" : "are"} working on a reply…
          </p>
        )}
        <ActionForm action={sendMessageAction.bind(null, id)} submitLabel="Send" resetOnSuccess>
          <MentionTextarea label="Message" name="body" rows={2} options={mentionOptions} required />
        </ActionForm>
      </div>
    </>
  );
}
