import { NoPermission, PageHeader } from "@/components/page";
import { requireUser } from "@/server/auth";
import { PageForm } from "../shared";

export const metadata = { title: "New wiki page" };

export default async function NewWikiPage({ searchParams }: PageProps<"/wiki/new">) {
  const user = await requireUser();
  if (!user.permissions.has("knowledge.manage")) return <NoPermission />;
  const sp = await searchParams;
  const one = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/.test(v) ? v : undefined);
  return (
    <>
      <PageHeader title="New wiki page" />
      <div className="max-w-3xl">
        <PageForm orgId={user.orgId} defaults={{ parentId: one(sp.parent), assetId: one(sp.asset) }} />
      </div>
    </>
  );
}
