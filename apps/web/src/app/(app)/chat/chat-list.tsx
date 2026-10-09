"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface ChatListItem {
  id: string;
  kind: "dm" | "channel";
  title: string;
  unread: number;
}

/** The left pane of Chat, Slack-style: channels, then direct messages, unread ones in bold with a count. */
export function ChatList({ items, label }: { items: ChatListItem[]; label: string }) {
  const pathname = usePathname();
  const groups = [
    { title: "Channels", rows: items.filter((c) => c.kind === "channel"), empty: "No channels yet." },
    { title: "Direct messages", rows: items.filter((c) => c.kind === "dm"), empty: "No direct messages yet." },
  ];
  return (
    <nav aria-label={label} className="grid content-start gap-4">
      {groups.map((g) => (
        <div key={g.title} className="grid gap-0.5">
          <h2 className="px-2 pb-1 font-mono text-[11px] tracking-wider text-dim uppercase">{g.title}</h2>
          {g.rows.length === 0 && <p className="px-2 text-xs text-muted-foreground">{g.empty}</p>}
          {g.rows.map((c) => {
            const active = pathname === `/chat/${c.id}`;
            // The one you're reading is being marked read as the page loads.
            const unread = active ? 0 : c.unread;
            return (
              <Link
                key={c.id}
                href={`/chat/${c.id}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-9 items-center gap-2 px-2 text-sm",
                  active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  unread > 0 && "font-semibold text-foreground",
                )}
              >
                <span className="flex-1 truncate">{c.title}</span>
                {unread > 0 && (
                  <span className="min-w-5 bg-phosphor px-1 text-center font-mono text-xs text-on-brand" aria-label={`${unread} unread`}>
                    {unread}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
