"use server";

import { getIntegration, integrationLicensed, PAGERDUTY_API_SECRET } from "@moss/core";
import { revalidatePath } from "next/cache";
import { act, type ActionState } from "@/server/action";
import { PermissionError, requirePermission } from "@/server/auth";
import { db } from "@/server/db";
import { storeSecret } from "@/server/services";

export async function savePagerdutyApiKeyAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    if (!user.permissions.has("secrets.manage")) throw new PermissionError("secrets.manage");
    if (!(await integrationLicensed(db(), user.orgId, getIntegration("pagerduty")!))) throw new Error("PagerDuty needs a business licence: add one in Settings → About.");
    const key = String(form.get("apiKey") ?? "").trim();
    if (!/^[A-Za-z0-9_+-]{20,64}$/.test(key)) throw new Error("That doesn't look like a PagerDuty API key.");
    await storeSecret({ userId: user.id, name: PAGERDUTY_API_SECRET, type: "api_token", value: key, description: "PagerDuty read-only REST API key (PagerDuty integration)", allowedTools: ["pagerduty_incidents"] });
    revalidatePath("/settings/integrations/pagerduty");
    return "Saved the API key.";
  });
}
