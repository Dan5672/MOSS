"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface ChatNavItem {
  id: string;
  title: string;
  unread: number;
}

/** Recent conversations under the sidebar menu, Slack-style: unread ones in bold with a count. */
export function ChatNav({ items }: { items: ChatNavItem[] }) {
  const pathname = usePathname();
  if (!items.length) return null;
  return (
    <nav aria-label="Recent chats" className="grid gap-0.5 border-t-2 pt-3">
      <span className="px-3 pb-1 font-mono text-[11px] tracking-wider text-dim uppercase">Chats</span>
      {items.map((c) => {
        const active = pathname === `/chat/${c.id}`;
        // The one you're reading is being marked read as the page loads.
        const unread = active ? 0 : c.unread;
        return (
          <Link
            key={c.id}
            href={`/chat/${c.id}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-9 items-center gap-2 px-3 text-sm",
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
    </nav>
  );
}
