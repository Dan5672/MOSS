import { ensureGeneralChannel } from "@moss/core";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";

export const metadata = { title: "Chat" };

/** Chat opens on the company-wide channel. */
export default async function ChatPage() {
  const user = await requireUser();
  redirect(`/chat/${await ensureGeneralChannel(db(), user.orgId)}`);
}
