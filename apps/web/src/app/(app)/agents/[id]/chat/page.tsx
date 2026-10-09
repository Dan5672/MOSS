import { openDm } from "@moss/core";
import { notFound, redirect } from "next/navigation";
import { NoPermission } from "@/components/page";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";

/** Chat with an agent now lives in Chat: this opens (or starts) your direct message with it. */
export default async function AgentChatRedirect({ params }: PageProps<"/agents/[id]/chat">) {
  const { id } = await params;
  const user = await requireUser();
  if (!user.permissions.has("agents.chat")) return <NoPermission />;
  const conversationId = await openDm(db(), user.orgId, user.id, { type: "agent", id }).catch(() => null);
  if (!conversationId) notFound();
  redirect(`/chat/${conversationId}`);
}
