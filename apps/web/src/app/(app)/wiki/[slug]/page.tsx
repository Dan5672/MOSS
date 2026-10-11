import { findPage, listPages } from "@moss/core";
import { assets } from "@moss/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Markdown } from "@/components/markdown";
import { NoPermission, PageHeader, timeAgo } from "@/components/page";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { nameLookup } from "@/server/people";
import { deletePageAction } from "../actions";
import { ancestors, linkResolver } from "../shared";

export default async function WikiPageView({ params }: PageProps<"/wiki/[slug]">) {
  const { slug } = await params;
  const user = await requireUser();
  if (!user.permissions.has("knowledge.read")) return <NoPermission />;
  const page = await findPage(db(), user.orgId, decodeURIComponent(slug));
  if (!page) notFound();
  const [pages, name, [asset]] = await Promise.all([
    listPages(db(), user.orgId),
    nameLookup(user.orgId),
    page.assetId ? db().select({ id: assets.id, name: assets.name }).from(assets).where(eq(assets.id, page.assetId)) : Promise.resolve([]),
  ]);
  const trail = ancestors(pages, page);
  const children = pages.filter((p) => p.parentId === page.id);
  const canEdit = user.permissions.has("knowledge.manage");

  return (
    <>
      <PageHeader
        title={page.title}
        trail={[{ href: "/wiki", label: "Wiki" }, ...trail.map((p) => ({ href: `/wiki/${p.slug}`, label: p.title }))]}
        description={
          <span>
            Last edited by {name(page.updatedByAgentId ?? page.updatedByUserId, "someone")} <span className="font-mono">{timeAgo(page.updatedAt)}</span>
            {asset && (
              <>
                {" "}
                · about{" "}
                <Link href={`/assets/${asset.id}`} className="underline">
                  {asset.name}
                </Link>
              </>
            )}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Link href={`/wiki/${page.slug}/history`} className="underline underline-offset-2">
              History
            </Link>
            {canEdit && (
              <>
                <Link href={`/wiki/new?parent=${page.id}`} className="underline underline-offset-2">
                  New page under this
                </Link>
                <Link href={`/wiki/${page.slug}/edit`} className="inline-flex min-h-10 items-center bg-phosphor px-4 font-medium text-on-brand">
                  Edit
                </Link>
              </>
            )}
          </div>
        }
      />
      <article className="px-frame max-w-3xl bg-card p-5">
        <Markdown text={page.body} links={linkResolver(pages)} />
      </article>
      {children.length > 0 && (
        <section aria-labelledby="wiki-children" className="mt-6 grid gap-2">
          <h2 id="wiki-children" className="text-base font-semibold">
            Pages under this
          </h2>
          <ul className="grid gap-1 text-sm">
            {children.map((c) => (
              <li key={c.id}>
                <Link href={`/wiki/${c.slug}`} className="underline-offset-2 hover:underline">
                  {c.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {canEdit && (
        <div className="mt-8">
          <ActionForm
            action={deletePageAction.bind(null, page.id)}
            submitLabel="Delete page"
            submitVariant="outline"
            confirm={`Delete "${page.title}"? Pages under it move up a level. This can't be undone.`}
          />
        </div>
      )}
    </>
  );
}
