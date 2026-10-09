import Link from "next/link";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/runs", label: "Agent activity" },
  { href: "/audit", label: "Audit log" },
] as const;

/** Sub-navigation for Activity: what agents did, and the audit log of every action. */
export function ActivityTabs({ current }: { current: (typeof TABS)[number]["href"] }) {
  return (
    <nav aria-label="Activity" className="mb-6 flex flex-wrap gap-1 border-b-2">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.href === current ? "page" : undefined}
          className={cn(
            "-mb-0.5 flex min-h-11 items-center border-b-2 px-4 text-sm",
            t.href === current ? "border-phosphor font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
