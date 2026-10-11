import { latestChanges } from "@moss/agent";
import { getSetting, MOSS_REPOSITORY, type ReleaseCheck } from "@moss/core";
import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ActionForm } from "@/components/action-form";
import { PageHeader, timeAgo } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/auth";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { checkForUpdatesAction } from "./actions";
import { LicenceCard } from "./licence-card";

export const metadata = { title: "About MOSS" };

async function migrationCount(): Promise<number | null> {
  try {
    const rows = (await db().execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as { n: number }[];
    return rows[0]?.n ?? null;
  } catch {
    return null;
  }
}

/** "v0.1.1-88-g741af22" -> a sentence about the development build; null for a release or an unknown version. */
function describeBuild(running: string): string {
  if (running === "dev") return "This install was built without deploy/upgrade.sh, so its version isn't recorded.";
  const m = /^(v[\d.]+)-(\d+)-g([0-9a-f]+)/.exec(running);
  return m ? `A development build: ${m[2]} changes after ${m[1]} (commit ${m[3]}).` : "A release.";
}

/** One changelog item: "**Title**: text" across several lines. */
function ChangeItem({ text }: { text: string }) {
  const m = /^\*\*(.+?)\*\*:?\s*([\s\S]*)$/.exec(text);
  return <li>{m ? <><strong>{m[1]}</strong>: {m[2]}</> : text}</li>;
}

/** What's running, whether there's a newer release, and what changed. */
export default async function AboutPage() {
  const user = await requireUser();
  const running = process.env.MOSS_RELEASE ?? "dev";
  const [check, migrations, changelog] = await Promise.all([
    getSetting(db(), user.orgId, "moss.update_check") as Promise<Partial<ReleaseCheck> & { at?: string }>,
    migrationCount(),
    readFile(join(config.libraryDir(), "docs", "changelog.md"), "utf8").catch(() => null),
  ]);
  const news = changelog ? latestChanges(changelog) : null;
  const items = news ? news.body.split(/\n(?=- )/).map((i) => i.replace(/^- /, "").replace(/\s*\n\s*/g, " ").trim()).filter(Boolean) : [];
  // A check made from an older build says nothing about this one.
  const fresh = check.at && check.running === running ? check : null;

  return (
    <>
      <PageHeader title="About MOSS" description="The version running here, whether there's a newer one, and your licence." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card id="version">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Version <span className="font-mono">{running}</span>
              {fresh?.status === "update" && <Badge variant="destructive">Update available</Badge>}
              {fresh?.status === "current" && <Badge variant="outline">Up to date</Badge>}
              {fresh?.status === "ahead" && <Badge variant="outline">Development build</Badge>}
            </CardTitle>
            <CardDescription>{describeBuild(running)}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Database</dt>
              <dd>{migrations === null ? "unknown" : `${migrations} migrations applied`}</dd>
              <dt className="text-muted-foreground">Source</dt>
              <dd>
                <a href={MOSS_REPOSITORY} className="underline underline-offset-2" target="_blank" rel="noreferrer">
                  {MOSS_REPOSITORY.replace("https://", "")}
                </a>
              </dd>
              <dt className="text-muted-foreground">Last checked</dt>
              <dd>
                {fresh ? (
                  <>
                    {timeAgo(new Date(fresh.at!))}
                    {fresh.latest && (
                      <>
                        {" · newest release "}
                        {fresh.url ? (
                          <a href={fresh.url} className="underline underline-offset-2" target="_blank" rel="noreferrer">
                            {fresh.latest}
                          </a>
                        ) : (
                          fresh.latest
                        )}
                      </>
                    )}
                  </>
                ) : (
                  "never"
                )}
              </dd>
            </dl>
            <ActionForm action={checkForUpdatesAction} submitLabel="Check for updates" submitVariant="outline" />
            <p className="text-xs text-muted-foreground">Checking asks GitHub for MOSS&apos;s list of releases. Nothing about this install is sent.</p>
            {fresh?.status === "update" && (
              <div className="grid gap-2 border-t pt-3">
                <p>
                  To update, run this on the machine MOSS is installed on, in the MOSS folder. It backs MOSS up first, and MOSS keeps running while
                  the new version builds:
                </p>
                <code className="block bg-muted p-2 font-mono text-xs">sh deploy/upgrade.sh {fresh.latest}</code>
                <p className="text-xs text-muted-foreground">
                  If something&apos;s wrong afterwards, <code>sh deploy/upgrade.sh --rollback</code> goes back.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
        <LicenceCard orgId={user.orgId} canManage={user.permissions.has("settings.manage")} />
        {news && (
          <Card id="whats-new">
            <CardHeader>
              <CardTitle>What&apos;s new in {news.version}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="grid list-disc gap-1.5 pl-5 text-sm">
                {items.map((i) => (
                  <ChangeItem key={i} text={i} />
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
