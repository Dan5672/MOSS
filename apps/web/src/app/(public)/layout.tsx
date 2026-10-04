import { connection } from "next/server";

export default async function PublicLayout({ children }: LayoutProps<"/">) {
  // Setup and login depend on the database, so never prerender them at build time.
  await connection();
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="text-3xl font-bold tracking-tight">MOSS</div>
          <div className="text-sm text-muted-foreground">Managed Operations &amp; Systems Service</div>
        </div>
        {children}
      </div>
    </main>
  );
}
