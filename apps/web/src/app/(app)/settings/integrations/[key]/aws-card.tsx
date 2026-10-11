import { AWS_POLICY, awsAcknowledged, getIntegration, loadIntegration, type AwsState } from "@moss/core";
import { ActionForm } from "@/components/action-form";
import { timeAgo } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/server/db";
import { acknowledgeAwsFindingAction, forgetAwsFindingAction } from "./aws-actions";

/** The read-only IAM policy to attach, and what the exposure report found. */
export async function AwsCards({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const { config, state } = await loadIntegration(db(), orgId, getIntegration("aws")!);
  const report = (state as AwsState).exposure;
  const known = new Set(awsAcknowledged(config));
  const fresh = report?.findings.filter((f) => !known.has(f.key)) ?? [];
  return (
    <>
      <Card id="policy" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>The IAM policy</CardTitle>
          <CardDescription>Attach only this to MOSS&apos;s IAM user: it can read, and change nothing.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-72 overflow-auto bg-muted p-2 font-mono text-xs" aria-label="IAM policy">
            {AWS_POLICY}
          </pre>
        </CardContent>
      </Card>
      <Card id="exposure" className="scroll-mt-6 lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Exposure {fresh.length > 0 && <Badge variant="destructive">{fresh.length} new</Badge>}
          </CardTitle>
          <CardDescription>
            What the internet can reach in your account: instances with public addresses, security groups open to the world on sensitive ports, public
            S3 buckets and databases.
            {report ? ` Last checked ${timeAgo(new Date(report.at))}.` : " Not checked yet: switch on the exposure report, then Sync now."}
          </CardDescription>
        </CardHeader>
        {report && (
          <CardContent className="grid gap-3">
            {report.findings.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing found.</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {report.findings.map((f) => (
                  <li key={f.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                    <span className="font-medium break-all">{f.resource}</span>
                    <span className="text-muted-foreground">
                      {f.issue}
                      {f.region ? ` (${f.region})` : ""}
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      {known.has(f.key) ? <Badge variant="outline">Expected</Badge> : <Badge variant="destructive">New</Badge>}
                      {canManage &&
                        (known.has(f.key) ? (
                          <ActionForm action={forgetAwsFindingAction.bind(null, f.key)} submitLabel="Unmark" submitVariant="secondary" inline />
                        ) : (
                          <ActionForm action={acknowledgeAwsFindingAction.bind(null, f.key)} submitLabel="Mark as expected" submitVariant="outline" inline />
                        ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canManage && fresh.length > 1 && <ActionForm action={acknowledgeAwsFindingAction.bind(null, null)} submitLabel="Mark all as expected" />}
          </CardContent>
        )}
      </Card>
    </>
  );
}
