import { listPages } from "@moss/core";
import { assets } from "@moss/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { SelectField, TextAreaField, TextField } from "@/components/field";
import type { PageLinks } from "@/components/markdown";
import { db } from "@/server/db";
import { savePageAction } from "./actions";

type Page = Awaited<ReturnType<typeof listPages>>[number];

/** Resolves [[Page title]] (or a slug) to the page's address. */
export function linkResolver(pages: Page[]): PageLinks {
  const byKey = new Map<string, string>();
  for (const p of pages) {
    if (p.slug) {
      byKey.set(p.title.toLowerCase(), p.slug);
      byKey.set(p.slug, p.slug);
    }
  }
  return (title) => {
    const slug = byKey.get(title.toLowerCase());
    return slug ? `/wiki/${slug}` : null;
  };
}

/** The pages above this one, top first. */
export function ancestors(pages: Page[], page: { parentId: string | null }): Page[] {
  const out: Page[] = [];
  for (let at = page.parentId, hops = 0; at && hops < 50; hops++) {
    const p = pages.find((x) => x.id === at);
    if (!p) break;
    out.unshift(p);
    at = p.parentId;
  }
  return out;
}

/**
 * Pages as an indented list, parents first, for the parent picker and the index. With skipId, that page and
 * everything under it are left out (a page can't go under itself or its own children).
 */
export function flattenTree(pages: Page[], skipId?: string): { page: Page; depth: number }[] {
  const skipped = new Set<string>();
  if (skipId) {
    const mark = (id: string) => {
      skipped.add(id);
      for (const c of pages.filter((p) => p.parentId === id)) if (!skipped.has(c.id)) mark(c.id);
    };
    mark(skipId);
  }
  const out: { page: Page; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const p of pages.filter((x) => x.parentId === parentId && !skipped.has(x.id))) {
      out.push({ page: p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  // Pages whose parent is gone (or skipped) still show, at the top level.
  for (const p of pages) if (!skipped.has(p.id) && !out.some((o) => o.page.id === p.id)) out.push({ page: p, depth: 0 });
  return out;
}

export async function PageForm({
  orgId,
  page,
  defaults,
}: {
  orgId: string;
  page?: { id: string; title: string; body: string; parentId: string | null; assetId: string | null };
  defaults?: { parentId?: string; assetId?: string };
}) {
  const [pages, assetRows] = await Promise.all([
    listPages(db(), orgId),
    db().select({ id: assets.id, name: assets.name, ip: assets.primaryIp }).from(assets).where(and(eq(assets.orgId, orgId), ne(assets.status, "retired"))).orderBy(asc(assets.name)).limit(500),
  ]);
  return (
    <ActionForm action={savePageAction.bind(null, page?.id ?? null)} submitLabel={page ? "Save page" : "Create page"}>
      <TextField label="Title" name="title" defaultValue={page?.title} required maxLength={120} placeholder="Living room access point" />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Under"
          name="parentId"
          defaultValue={page?.parentId ?? defaults?.parentId ?? ""}
          options={[{ value: "", label: "Top level" }, ...flattenTree(pages, page?.id).map(({ page: p, depth }) => ({ value: p.id, label: `${"— ".repeat(depth)}${p.title}` }))]}
        />
        <SelectField
          label="About this device"
          name="assetId"
          defaultValue={page?.assetId ?? defaults?.assetId ?? ""}
          options={[{ value: "", label: "None" }, ...assetRows.map((a) => ({ value: a.id, label: a.ip ? `${a.name} (${a.ip})` : a.name }))]}
        />
      </div>
      <TextAreaField
        label="Page"
        name="body"
        rows={18}
        defaultValue={page?.body}
        required
        className="font-mono text-sm"
        hint="Markdown: # headings, - lists, **bold**, `code`, ``` code blocks, [[Another page]] to link a page."
      />
    </ActionForm>
  );
}
