import { agentRuns, agents, conversationMessages, runSteps, tokenUsage } from "@moss/db";
import { and, asc, eq, sum } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Pill, StatusBadge } from "@/components/badges";
import { TextAreaField } from "@/components/field";
import { formatUsd, PageHeader, timeAgo, NoPermission } from "@/components/page";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { replyToRunAction } from "../../chat/actions";

type StepContent = Record<string, unknown> & {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
  name?: string;
  content?: string;
  isError?: boolean;
  code?: string;
  reason?: string;
  message?: string;
};

export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  if (!user.permissions.has("agents.read")) return <NoPermission />;
  const [row] = await db()
    .select({ run: agentRuns, agent: agents })
    .from(agentRuns)
    .innerJoin(agents, eq(agentRuns.agentId, agents.id))
    .where(and(eq(agentRuns.id, id), eq(agentRuns.orgId, user.orgId)));
  if (!row) notFound();
  const [steps, [usage], [asked]] = await Promise.all([
    db().select().from(runSteps).where(eq(runSteps.runId, id)).orderBy(asc(runSteps.seq)),
    db()
      .select({ usd: sum(tokenUsage.costUsd), input: sum(tokenUsage.inputTokens), output: sum(tokenUsage.outputTokens) })
      .from(tokenUsage)
      .where(eq(tokenUsage.runId, id)),
    // A question it asked with ask_user.
    db().select().from(conversationMessages).where(and(eq(conversationMessages.runId, id), eq(conversationMessages.authorAgentId, row.agent.id))).limit(1),
  ]);
  const { run, agent } = row;
  const question = asked?.body ?? (run.status !== "running" && run.trigger !== "chat" && run.summary?.trim().endsWith("?") ? run.summary : null);
  const canReply = !!question && agent.status === "active" && user.permissions.has("agents.chat");

  return (
    <>
      <PageHeader
        title={`Run by ${agent.name}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} /> {run.trigger} · started <span className="font-mono">{timeAgo(run.startedAt)}</span> · <span className="font-mono">{formatUsd(Number(usage?.usd ?? 0))}</span> ·{" "}
            <span className="font-mono">{Number(usage?.input ?? 0).toLocaleString()} in / {Number(usage?.output ?? 0).toLocaleString()} out</span> tokens
          </span>
        }
        actions={<Link href={`/agents/${agent.id}`} className="text-sm underline">{agent.name}</Link>}
      />
      {run.task && run.trigger !== "chat" && (
        <details className="mb-4 text-sm">
          <summary className="cursor-pointer text-muted-foreground">The task</summary>
          <p className="mt-2 px-frame p-3 whitespace-pre-wrap">{run.task}</p>
        </details>
      )}
      {run.summary && <p className="mb-6 px-frame p-4 text-sm whitespace-pre-wrap">{run.summary}</p>}
      {question && (
        <section aria-labelledby="run-question" className="mb-6 grid gap-3 border-2 border-amber p-4">
          <h2 id="run-question" className="text-sm font-semibold">
            {agent.name} asked
          </h2>
          <p className="text-sm whitespace-pre-wrap">{question}</p>
          {canReply && (
            <ActionForm action={replyToRunAction.bind(null, id)} submitLabel="Reply">
              <TextAreaField label="Your answer" name="answer" rows={2} required />
            </ActionForm>
          )}
        </section>
      )}
      <ol className="space-y-2">
        {steps.map((s) => {
          const c = s.content as StepContent;
          return (
            <li key={s.id} className="px-frame p-3 text-sm">
              {s.kind === "message" && (
                <>
                  {c.text && <p className="whitespace-pre-wrap">{c.text}</p>}
                  {c.toolCalls?.map((t, i) => (
                    <div key={i} className="mt-1 flex flex-wrap items-baseline gap-2">
                      <Pill tone="blue">calls</Pill>
                      <span className="font-mono text-xs">{t.name}</span>
                      <code className="break-all text-xs text-muted-foreground">{JSON.stringify(t.input)}</code>
                    </div>
                  ))}
                </>
              )}
              {s.kind === "tool_result" && (
                <details>
                  <summary className="cursor-pointer">
                    <Pill tone={c.isError ? "red" : "green"}>{c.isError ? "error" : "result"}</Pill> <span className="font-mono text-xs">{c.name}</span>
                  </summary>
                  {/* Tool output is untrusted data from the network: shown as text only, never rendered as HTML. */}
                  <pre className="mt-2 max-h-80 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{c.content}</pre>
                </details>
              )}
              {s.kind === "policy_denied" && (
                <div className="flex flex-wrap items-baseline gap-2">
                  <Pill tone="red">denied by policy</Pill>
                  <span className="font-mono text-xs">{c.name}</span>
                  <span className="text-muted-foreground">
                    {c.code}: {c.reason}
                  </span>
                </div>
              )}
              {s.kind === "error" && (
                <div className="flex gap-2">
                  <Pill tone="red">error</Pill> {c.message}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
