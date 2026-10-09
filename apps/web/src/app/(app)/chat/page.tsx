import { listConversations, mentionables } from "@moss/core";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { CheckboxField, SelectField, TextField } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Empty, PageHeader, timeAgo } from "@/components/page";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { createChannelAction, openDmAction } from "./actions";

export const metadata = { title: "Chat" };

export default async function ChatPage() {
  const user = await requireUser();
  const [list, everyone] = await Promise.all([listConversations(db(), user.orgId, user.id), mentionables(db(), user.orgId)]);
  const others = everyone.filter((m) => !(m.type === "user" && m.id === user.id)).filter((m) => m.type === "user" || user.permissions.has("agents.chat"));
  const options = others.map((m) => ({ value: `${m.type}:${m.id}`, label: `${m.name} (${m.type === "agent" ? "agent" : "person"})` }));
  const channels = list.filter((c) => c.kind === "channel");
  const dms = list.filter((c) => c.kind === "dm");

  const row = (c: (typeof list)[number]) => (
    <li key={c.id}>
      <Link href={`/chat/${c.id}`} className="px-frame flex items-center justify-between gap-3 bg-card p-3 hover:bg-accent">
        <span className={c.unread ? "font-semibold" : undefined}>{c.title}</span>
        <span className="flex items-center gap-3 font-mono text-xs text-dim">
          {timeAgo(c.updatedAt)}
          {c.unread > 0 && (
            <span className="min-w-5 bg-phosphor px-1 text-center text-on-brand" aria-label={`${c.unread} unread`}>
              {c.unread}
            </span>
          )}
        </span>
      </Link>
    </li>
  );

  return (
    <>
      <PageHeader
        title="Chat"
        description="Message your agents and the people you work with, one to one or in channels. Agents reply when you message them directly, or @mention them in a channel."
        actions={
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
        }
      />
      {list.length === 0 ? (
        <Empty>No conversations yet. Start one with New message.</Empty>
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          <section aria-labelledby="chat-channels" className="grid content-start gap-2">
            <h2 id="chat-channels" className="text-base font-semibold">
              Channels
            </h2>
            {channels.length ? <ul className="grid gap-2">{channels.map(row)}</ul> : <p className="text-sm text-muted-foreground">No channels yet.</p>}
          </section>
          <section aria-labelledby="chat-dms" className="grid content-start gap-2">
            <h2 id="chat-dms" className="text-base font-semibold">
              Direct messages
            </h2>
            {dms.length ? <ul className="grid gap-2">{dms.map(row)}</ul> : <p className="text-sm text-muted-foreground">No direct messages yet.</p>}
          </section>
        </div>
      )}
    </>
  );
}
