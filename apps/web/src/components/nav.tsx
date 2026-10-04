"use client";

import {
  Activity,
  Bot,
  Boxes,
  ClipboardList,
  Cpu,
  GitPullRequestArrow,
  LayoutDashboard,
  Network,
  ScrollText,
  Settings,
  Siren,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/models", label: "Models", icon: Cpu },
  { href: "/assets", label: "Assets", icon: Boxes },
  { href: "/networks", label: "Networks", icon: Network },
  { href: "/monitoring", label: "Monitoring", icon: Activity },
  { href: "/incidents", label: "Incidents", icon: Siren },
  { href: "/changes", label: "Changes", icon: GitPullRequestArrow },
  { href: "/runs", label: "Agent activity", icon: ClipboardList },
  { href: "/audit", label: "Audit log", icon: ScrollText },
  { href: "/users", label: "Users", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Nav({ badges }: { badges: Record<string, number> }) {
  const pathname = usePathname();
  return (
    <nav className="grid gap-0.5">
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
        const count = badges[href];
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">{label}</span>
            {count ? (
              <span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground" aria-label={href === "/monitoring" ? `${count} down` : `${count} pending`}>
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
