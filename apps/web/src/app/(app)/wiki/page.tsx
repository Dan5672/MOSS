import { listPages, searchNotes } from "@moss/core";
import Link from "next/link";
import { Empty, NoPermission, PageHeader, timeAgo } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { flattenTree } from "./shared";

export const metadata = { title: "Wiki" };

export default async function WikiPage({ searchParams }: PageProps<"/wiki">) {
  const user = await requireUser();
  if (!user.permissions.has("knowledge.read")) return <NoPermission />;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const [pages, found] = await Promise.all([listPages(db(), user.orgId), q ? searchNotes(db(), user.orgId, { query: q, limit: 50 }) : Promise.resolve(null)]);
  const tree = flattenTree(pages);

  return (
    <>
      <PageHeader
        title="Wiki"
        description="What the team knows about your network: devices, the layout, how-tos and decisions. Agents keep it current as they work; anyone can edit it."
        actions={
          user.permissions.has("knowledge.manage") && (
            <Link href="/wiki/new" className="inline-flex min-h-10 items-center bg-phosphor px-4 text-sm font-medium text-on-brand">
              New page
            </Link>
          )
        }
      />
      <form className="mb-6 flex gap-2" role="search">
        <Input name="q" defaultValue={q} placeholder="Search the wiki" aria-label="Search the wiki" className="max-w-md" />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {found ? (
        found.length === 0 ? (
          <Empty>No pages match.</Empty>
        ) : (
          <ul aria-label="Search results" className="grid gap-2">
            {found.map((p) => (
              <li key={p.id} className="px-frame bg-card p-3 text-sm">
                <Link href={`/wiki/${p.slug}`} className="font-medium hover:underline">
                  {p.title}
                </Link>
                <p className="mt-1 line-clamp-2 text-muted-foreground">{p.body.slice(0, 240)}</p>
              </li>
            ))}
          </ul>
        )
      ) : tree.length === 0 ? (
        <Empty>No pages yet. Agents with the Network Wiki skill start filling it in as they work, or write the first page yourself.</Empty>
      ) : (
        <ul aria-label="Pages" className="grid gap-1">
          {tree.map(({ page, depth }) => (
            <li key={page.id} style={{ paddingLeft: depth * 20 }} className="flex flex-wrap items-baseline gap-x-3 text-sm">
              <Link href={`/wiki/${page.slug}`} className={depth === 0 ? "font-semibold hover:underline" : "hover:underline"}>
                {page.title}
              </Link>
              <span className="font-mono text-xs text-dim">{timeAgo(page.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
