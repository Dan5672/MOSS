import { PAGERDUTY_API_SECRET } from "@moss/core";
import { secrets } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { TextField } from "@/components/field";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/server/db";
import { savePagerdutyApiKeyAction } from "./pagerduty-actions";

/** PagerDuty's optional REST API key: who acknowledged or resolved each page, back in MOSS. */
export async function PagerdutyApiKeyCard({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const [saved] = await db().select({ id: secrets.id }).from(secrets).where(and(eq(secrets.orgId, orgId), eq(secrets.name, PAGERDUTY_API_SECRET)));
  return (
    <Card id="acknowledgements" className="scroll-mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Acknowledgements <Badge variant={saved ? "default" : "outline"}>{saved ? "Key saved" : "Optional"}</Badge>
        </CardTitle>
        <CardDescription>
          To see in MOSS who acknowledged or resolved a page, add a read-only REST API key (PagerDuty: Integrations → API Access Keys → Create New API
          Key, Read-only), then switch on Acknowledgements in MOSS above. Paging works without it.
        </CardDescription>
      </CardHeader>
      {canManage && (
        <CardContent>
          <ActionForm action={savePagerdutyApiKeyAction} submitLabel="Save API key" resetOnSuccess>
            <TextField
              label="Read-only REST API key"
              name="apiKey"
              type="password"
              autoComplete="off"
              placeholder={saved ? "Saved. Paste a new one to replace it." : undefined}
              hint={`Stored encrypted as secret:${PAGERDUTY_API_SECRET}, usable only to read PagerDuty's incidents.`}
              required
            />
          </ActionForm>
        </CardContent>
      )}
    </Card>
  );
}
