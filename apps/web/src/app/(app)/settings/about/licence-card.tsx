import { getLicenceStatus, getIntegration, INTEGRATIONS } from "@moss/core";
import { ActionForm } from "@/components/action-form";
import { TextAreaField } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/server/db";
import { removeLicenceAction, saveLicenceAction } from "./actions";

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

function LicenceDialog({ label }: { label: string }) {
  return (
    <FormDialog label={label} variant="outline" title="Add a business licence" description="Paste the licence key you were sent. It's checked on this machine: nothing is sent anywhere.">
      <ActionForm action={saveLicenceAction} submitLabel="Check and add">
        <TextAreaField label="Licence key" name="licence" rows={5} required placeholder="MOSS1.…" />
      </ActionForm>
    </FormDialog>
  );
}

/** The business licence: what it covers and until when; adding, replacing or removing it. */
export async function LicenceCard({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const status = await getLicenceStatus(db(), orgId);
  const l = status.licence;
  const business = INTEGRATIONS.filter((d) => d.plan === "business").map((d) => d.name);
  const covers = l ? (l.features.includes("*") ? "Every business integration" : l.features.map((k) => getIntegration(k)?.name ?? k).join(", ")) : null;

  return (
    <Card id="licence" className="scroll-mt-6">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Business licence
          {status.state === "valid" && <Badge variant="outline">Active</Badge>}
          {status.state === "grace" && <Badge variant="destructive">Expired</Badge>}
          {status.state === "expired" && <Badge variant="destructive">Stopped</Badge>}
          {status.state === "none" && <Badge variant="outline">None</Badge>}
        </CardTitle>
        <CardDescription>
          Business integrations{business.length ? ` (${business.join(", ")})` : ""} need a licence. Everything else in MOSS is free.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {l && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Licensed to</dt>
            <dd>{l.licensee}</dd>
            <dt className="text-muted-foreground">Covers</dt>
            <dd>{covers}</dd>
            {l.maxUsers && (
              <>
                <dt className="text-muted-foreground">People</dt>
                <dd>up to {l.maxUsers}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{status.state === "valid" ? "Until" : "Expired"}</dt>
            <dd>{day(l.expires)}</dd>
          </dl>
        )}
        {status.state === "grace" && (
          <p role="alert" className="text-destructive">
            Business integrations keep working until {day(status.stopsAt!)}. Add a renewed licence before then.
          </p>
        )}
        {status.state === "expired" && (
          <p role="alert" className="text-destructive">
            Business integrations have stopped. Their settings are kept: add a renewed licence to switch them back on.
          </p>
        )}
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <LicenceDialog label={l ? "Replace licence" : "Add a licence"} />
            {l && (
              <ActionForm
                action={removeLicenceAction}
                submitLabel="Remove licence"
                submitVariant="outline"
                confirm="Remove the business licence? Business integrations stop straight away (their settings are kept)."
                inline
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
