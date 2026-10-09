import { findPage } from "@moss/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoPermission, PageHeader } from "@/components/page";
import { requireUser } from "@/server/auth";
import { db } from "@/server/db";
import { PageForm } from "../../shared";

export const metadata = { title: "Edit wiki page" };

export default async function EditWikiPage({ params }: PageProps<"/wiki/[slug]/edit">) {
  const { slug } = await params;
  const user = await requireUser();
  if (!user.permissions.has("knowledge.manage")) return <NoPermission />;
  const page = await findPage(db(), user.orgId, decodeURIComponent(slug));
  if (!page) notFound();
  return (
    <>
      <PageHeader
        title={`Edit: ${page.title}`}
        trail={[{ href: "/wiki", label: "Wiki" }, { href: `/wiki/${page.slug}`, label: page.title }]}
        description="The page as it is now is kept in its history when you save."
        actions={
          <Link href={`/wiki/${page.slug}`} className="text-sm underline underline-offset-2">
            Cancel
          </Link>
        }
      />
      <div className="max-w-3xl">
        <PageForm orgId={user.orgId} page={page} />
      </div>
    </>
  );
}
