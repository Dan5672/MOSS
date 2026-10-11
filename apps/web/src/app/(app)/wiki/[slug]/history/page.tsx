import { findPage, pageRevisions } from "@moss/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoPermission, PageHeader, timeAgo } from "@/components/page";
import { diffLines } from "@/lib/diff";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { nameLookup } from "@/server/people";

export const metadata = { title: "Wiki page history" };

/** Each edit, newest first: who made it, when, and what changed (lines removed and added). */
export default async function WikiHistory({ params }: PageProps<"/wiki/[slug]/history">) {
  const { slug } = await params;
  const user = await requireUser();
  if (!user.permissions.has("knowledge.read")) return <NoPermission />;
  const page = await findPage(db(), user.orgId, decodeURIComponent(slug));
  if (!page) notFound();
  const [revisions, name] = await Promise.all([pageRevisions(db(), page.id), nameLookup(user.orgId)]);
  // Versions newest first: the page as it is now, then each earlier version.
  const versions = [
    { id: "current", title: page.title, body: page.body, at: page.updatedAt, by: page.updatedByAgentId ?? page.updatedByUserId },
    ...revisions.map((r) => ({ id: r.id, title: r.title, body: r.body, at: r.createdAt, by: r.editedByAgentId ?? r.editedByUserId })),
  ];

  return (
    <>
      <PageHeader
        title={`History: ${page.title}`}
        trail={[{ href: "/wiki", label: "Wiki" }, { href: `/wiki/${page.slug}`, label: page.title }]}
        description={`${versions.length} version${versions.length === 1 ? "" : "s"}.`}
        actions={
          <Link href={`/wiki/${page.slug}`} className="text-sm underline underline-offset-2">
            Back to the page
          </Link>
        }
      />
      <ol className="grid gap-6">
        {versions.map((v, i) => {
          const previous = versions[i + 1];
          const changes = previous ? diffLines(previous.body, v.body).filter((d) => d.kind !== "same") : [];
          return (
            <li key={v.id} className="px-frame grid gap-2 bg-card p-4 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{i === 0 ? "Current version" : `Version ${versions.length - i}`}</span>
                <span className="text-muted-foreground">
                  by {name(v.by, "someone")} <span className="font-mono">{timeAgo(v.at)}</span>
                </span>
                {previous && previous.title !== v.title && <span className="text-muted-foreground">· renamed from &quot;{previous.title}&quot;</span>}
              </div>
              {previous ? (
                changes.length ? (
                  <pre aria-label="Changes" className="max-h-80 overflow-auto bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
                    {changes.map((d, j) => (
                      <div key={j} className={cn(d.kind === "added" ? "text-phosphor" : "text-alarm")}>
                        {d.kind === "added" ? "+ " : "- "}
                        {d.text}
                      </div>
                    ))}
                  </pre>
                ) : (
                  <p className="text-muted-foreground">No changes to the text.</p>
                )
              ) : (
                <p className="text-muted-foreground">The first version.</p>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
