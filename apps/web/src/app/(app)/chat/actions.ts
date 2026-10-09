"use server";

import { addToChannel, createChannel, leaveChannel, openDm, postMessage, writeAudit, type Member } from "@moss/core";
import { agentRuns, agents, conversationMessages } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requireUser, type CurrentUser } from "@/server/auth";
import { db } from "@/server/db";
import { queueRun } from "@/server/services";

/** "agent:<id>" or "user:<id>", as the pickers send them. */
const memberSchema = z
  .string()
  .regex(/^(agent|user):[0-9a-f-]{36}$/, "Choose someone")
  .transform((v): Member => {
    const [type, id] = v.split(":") as ["agent" | "user", string];
    return { type, id };
  });

/** Posts as this person, and asks the agents it's addressed to for a reply (if they may talk to agents). */
async function post(user: CurrentUser, conversationId: string, body: string) {
  const { agentsToAnswer } = await postMessage(db(), user.orgId, conversationId, { type: "user", id: user.id }, body);
  if (!agentsToAnswer.length) return null;
  if (!user.permissions.has("agents.chat")) return "Sent. Agents only reply to people who are allowed to chat with agents.";
  for (const agentId of agentsToAnswer) {
    // If the agent is busy this waits its turn; anything still unanswered is picked up when its run ends.
    await queueRun({ agentId, trigger: "chat", triggerRef: conversationId, task: "Reply in chat", requestedByUserId: user.id });
  }
  await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "agent.chat", targetType: "conversation", targetId: conversationId, details: { agents: agentsToAnswer, message: body.slice(0, 500) } });
  return null;
}

export async function sendMessageAction(conversationId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    const body = z.string().trim().min(1, "Write a message").max(8000).parse(form.get("body"));
    return (await post(user, conversationId, body)) ?? undefined;
  });
}

/** Starts (or reopens) a DM, optionally with a first message. */
export async function openDmAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    const other = memberSchema.parse(form.get("with"));
    if (other.type === "agent" && !user.permissions.has("agents.chat")) throw new Error("You don't have permission to chat with agents");
    const id = await openDm(db(), user.orgId, user.id, other);
    redirect(`/chat/${id}`);
  });
}

export async function createChannelAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    const f = z.object({ name: z.string().min(1, "Name the channel").max(41), topic: z.string().max(200).optional() }).parse(formObject(form));
    const members = form.getAll("members").map((v) => memberSchema.parse(String(v)));
    const id = await createChannel(db(), user.orgId, user.id, { name: f.name, topic: f.topic, members });
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "chat.channel_create", targetType: "conversation", targetId: id, details: { name: f.name, members } });
    redirect(`/chat/${id}`);
  });
}

export async function addMemberAction(conversationId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    const member = memberSchema.parse(form.get("member"));
    await addToChannel(db(), user.orgId, conversationId, user.id, member);
    return "Added to the channel.";
  });
}

export async function leaveChannelAction(conversationId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    await leaveChannel(db(), user.orgId, conversationId, user.id);
    redirect("/chat");
  });
}

/** Sends a message to an agent from elsewhere (the Basement panel, an agent's page): it lands in your DM. */
export async function messageAgentAction(agentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    if (!user.permissions.has("agents.chat")) throw new Error("You don't have permission to chat with agents");
    const body = z.string().trim().min(1, "Write a message").max(8000).parse(form.get("message"));
    const id = await openDm(db(), user.orgId, user.id, { type: "agent", id: agentId });
    return (await post(user, id, body)) ?? "Sent. The reply will be in your chat.";
  });
}

/** Answers an agent's question from its run page: in your DM with it, so it picks the work back up. */
export async function replyToRunAction(runId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    if (!user.permissions.has("agents.chat")) throw new Error("You don't have permission to chat with agents");
    const answer = z.string().trim().min(1, "Write your answer").max(8000).parse(form.get("answer"));
    const [row] = await db()
      .select({ run: agentRuns, agentName: agents.name })
      .from(agentRuns)
      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, user.orgId)));
    if (!row) throw new Error("Run not found");
    const conversationId = await openDm(db(), user.orgId, user.id, { type: "agent", id: row.run.agentId });
    const [asked] = await db()
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.runId, runId)))
      .limit(1);
    // A question asked with ask_user is already in the DM; one left in a run's summary isn't, so quote it.
    const body = asked ? answer : `About your question at the end of an earlier run: "${(row.run.summary ?? "").slice(-500)}"\n\n${answer}`;
    await post(user, conversationId, body);
    redirect(`/chat/${conversationId}`);
  });
}
