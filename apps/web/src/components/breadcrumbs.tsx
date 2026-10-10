"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";

export interface Crumb {
  href: string;
  label: string;
}

/** Names for the sections and sub-pages that can appear above the current page. */
const LABELS: Record<string, string> = {
  "/agents": "Agents",
  "/agents/custom-tools": "Custom tools",
  "/agents/recurring": "Recurring tasks",
  "/agents/tools": "Tool access",
  "/assets": "Assets",
  "/basement": "Basement",
  "/changes": "Changes",
  "/chat": "Chat",
  "/incidents": "Incidents",
  "/agents/models": "Models",
  "/monitoring": "Monitoring",
  "/monitoring/sources": "Webhook sources",
  "/notifications": "Notifications",
  "/runs": "Activity",
  "/settings": "Settings",
  "/settings/backups": "Backups",
  "/settings/modules": "Modules",
  "/settings/secrets": "Secrets",
  "/wiki": "Wiki",
};

/** Pages that live under another section's tabs: Networks and Users in Settings, the Audit log in Activity. */
const PARENT: Record<string, string> = { "/networks": "/settings", "/users": "/settings", "/audit": "/runs" };

/** The trail above a page, worked out from its address: /agents/123 gives B1 / Agents. */
export function autoTrail(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const trail: Crumb[] = [];
  const parent = PARENT[`/${segments[0] ?? ""}`];
  if (parent) trail.push({ href: parent, label: LABELS[parent]! });
  for (let i = 0; i < segments.length - 1; i++) {
    const href = `/${segments.slice(0, i + 1).join("/")}`;
    // Ids and slugs in the middle of an address have no name here; pages that need them pass a trail.
    if (LABELS[href]) trail.push({ href, label: LABELS[href] });
  }
  return trail;
}

/**
 * Where you are: B1 / Agents / Roy. Everything above the current page is a link. The current page's
 * name repeats the heading below it, so it's hidden from screen readers.
 */
export function Breadcrumbs({ title, trail }: { title: string; trail?: Crumb[] }) {
  const pathname = usePathname();
  const crumbs = trail ?? autoTrail(pathname);
  const link = "underline-offset-2 hover:text-foreground hover:underline";
  return (
    <nav aria-label="Breadcrumb" className="mb-2 font-mono text-xs tracking-[1.5px] text-dim">
      <ol className="flex flex-wrap items-center gap-x-1.5">
        <li>
          <Link href="/" className={link}>
            B1
          </Link>
        </li>
        {crumbs.map((c) => (
          <Fragment key={c.href}>
            <li aria-hidden>/</li>
            <li>
              <Link href={c.href} className={link}>
                {c.label.toUpperCase()}
              </Link>
            </li>
          </Fragment>
        ))}
        <li aria-hidden>/</li>
        <li aria-hidden className="truncate">
          {title.toUpperCase()}
        </li>
      </ol>
    </nav>
  );
}
