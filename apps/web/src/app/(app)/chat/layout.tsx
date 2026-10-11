import { ensureGeneralChannel, listConversations, mentionables } from "@moss/core";
import { ActionForm } from "@/components/action-form";
import { CheckboxField, SelectField, TextField } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { createChannelAction, openDmAction } from "./actions";
import { ChatList } from "./chat-list";

/**
 * Chat fills the screen, Slack-style: channels and direct messages on the left, the conversation on the
 * right with its message box pinned to the bottom.
 */
export default async function ChatLayout({ children }: LayoutProps<"/chat">) {
  const user = await requireUser();
  await ensureGeneralChannel(db(), user.orgId);
  const [list, everyone] = await Promise.all([listConversations(db(), user.orgId, user.id), mentionables(db(), user.orgId)]);
  const others = everyone.filter((m) => !(m.type === "user" && m.id === user.id)).filter((m) => m.type === "user" || user.permissions.has("agents.chat"));
  const options = others.map((m) => ({ value: `${m.type}:${m.id}`, label: `${m.name} (${m.type === "agent" ? "agent" : "person"})` }));
  const items = list.map((c) => ({ id: c.id, kind: c.kind, title: c.title, unread: c.unread }));

  const start = (
    <div className="flex flex-wrap gap-2">
      <FormDialog label="New message" title="New message" description="Start a direct message with an agent or a person.">
        <ActionForm action={openDmAction} submitLabel="Open">
          <SelectField label="With" name="with" options={[{ value: "", label: "Choose someone" }, ...options]} />
        </ActionForm>
      </FormDialog>
      <FormDialog label="New channel" title="New channel" description="A shared conversation, e.g. #network. Agents in it answer when they're @mentioned.">
        <ActionForm action={createChannelAction} submitLabel="Create channel">
          <TextField label="Name" name="name" placeholder="network" required maxLength={41} hint="Lowercase letters, digits and dashes." />
          <TextField label="Topic" name="topic" maxLength={200} placeholder="Wi-Fi, switches and the router" />
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Members</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {options.map((o) => (
                <CheckboxField key={o.value} label={o.label} name="members" value={o.value} />
              ))}
            </div>
          </fieldset>
        </ActionForm>
      </FormDialog>
    </div>
  );

  return (
    <div className="-mt-2 -mb-10 flex h-[calc(100dvh-7rem)] min-h-[28rem] flex-col gap-3 md:h-[calc(100dvh-2.5rem)] md:flex-row md:gap-6">
      <aside aria-label="Conversations" className="hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r-2 pr-4 md:flex">
        <p className="font-pixel text-[18px] text-ink dark:text-beige">Chat</p>
        {start}
        <ChatList items={items} label="Chats" />
      </aside>
      {/* Small screens: the list folds away above the conversation. */}
      <details className="shrink-0 border-2 p-2 md:hidden">
        <summary className="cursor-pointer font-mono text-xs">Channels and messages</summary>
        <div className="mt-3 grid gap-3">
          {start}
          <ChatList items={items} label="Chats" />
        </div>
      </details>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</section>
    </div>
  );
}
