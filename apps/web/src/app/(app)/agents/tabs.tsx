import Link from "next/link";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/agents", label: "Team" },
  { href: "/agents/tools", label: "Tool access" },
  { href: "/agents/custom-tools", label: "Custom tools" },
  { href: "/agents/knowledge", label: "Knowledge base" },
] as const;

/** Sub-navigation for the Agents section. */
export function AgentsTabs({ current }: { current: (typeof TABS)[number]["href"] }) {
  return (
    <nav aria-label="Agents" className="mb-6 flex flex-wrap gap-1 border-b-2">
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
