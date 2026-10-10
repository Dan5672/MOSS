"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface SectionTab {
  href: string;
  label: string;
}

/**
 * A section's tabs, rendered by the section's layout above the page header, so they stay in the same place
 * whatever each page's description says. The first tab matches only its own address; the others also match
 * the pages under them. On pages that aren't one of the tabs (an agent's own page, a run), nothing shows.
 */
export function SectionTabs({ label, tabs }: { label: string; tabs: readonly SectionTab[] }) {
  const pathname = usePathname();
  const active = tabs.find((t, i) => pathname === t.href || (i > 0 && pathname.startsWith(`${t.href}/`)));
  if (!active) return null;
  return (
    <nav aria-label={label} className="mb-6 flex flex-wrap gap-1 border-b-2">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t === active ? "page" : undefined}
          className={cn(
            "-mb-0.5 flex min-h-11 items-center border-b-2 px-4 text-sm",
            t === active ? "border-phosphor font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
