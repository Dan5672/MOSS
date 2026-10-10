import { connection } from "next/server";
import { Logo } from "@/components/logo";
import pkg from "../../../package.json";

export default async function PublicLayout({ children }: LayoutProps<"/">) {
  // Setup and login depend on the database, so never prerender them at build time.
  await connection();
  return (
    <main className="scanlines flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-4 py-10">
      <Logo variant="stacked" />
      <div className="px-frame terminal-form w-[calc(100%-8px)] max-w-[400px] bg-card p-7">{children}</div>
      <footer className="font-mono text-xs text-dim">v{pkg.version} · self-hosted</footer>
    </main>
  );
}
