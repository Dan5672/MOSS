"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Sidebar items. `also` lists other sections an item covers (shown as its tabs), so it stays highlighted there. */
export const NAV_ITEMS: { href: string; label: string; also?: string[] }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/basement", label: "Basement" },
  { href: "/chat", label: "Chat" },
  { href: "/agents", label: "Agents" },
  { href: "/assets", label: "Assets" },
  { href: "/wiki", label: "Wiki" },
  { href: "/monitoring", label: "Monitoring" },
  { href: "/incidents", label: "Incidents" },
  { href: "/changes", label: "Changes" },
  { href: "/runs", label: "Activity", also: ["/audit"] },
  { href: "/settings", label: "Settings", also: ["/users", "/networks"] },
];

/** Count chips: square, dark text on a coloured fill. Each keeps an aria-label saying what it counts. */
const BADGES: Record<string, { className: string; label: (n: number) => string }> = {
  "/chat": { className: "bg-phosphor", label: (n) => `${n} unread` },
  "/monitoring": { className: "bg-amber", label: (n) => `${n} down` },
  "/incidents": { className: "bg-alarm", label: (n) => `${n} open` },
  "/changes": { className: "bg-phosphor", label: (n) => `${n} pending` },
};

export function Nav({ badges }: { badges: Record<string, number> }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="grid gap-0.5">
      {NAV_ITEMS.map(({ href, label, also = [] }) => {
        const under = (h: string) => pathname === h || pathname.startsWith(`${h}/`);
        const active = href === "/" ? pathname === "/" : under(href) || also.some(under);
        const count = badges[href];
        const badge = BADGES[href];
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-10 items-center gap-2 px-3 text-sm transition-colors",
              active
                ? "bg-accent font-medium text-foreground shadow-[inset_3px_0_0_0_var(--phosphor)]"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <span className="flex-1">{label}</span>
            {count && badge ? (
              <span className={cn("min-w-5 px-1 text-center font-mono text-xs font-medium text-on-brand", badge.className)} aria-label={badge.label(count)}>
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
