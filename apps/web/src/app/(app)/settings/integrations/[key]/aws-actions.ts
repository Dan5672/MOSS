"use server";

import { awsAcknowledged, getIntegration, integrationLicensed, loadIntegration, saveModule, type AwsState } from "@moss/core";
import { revalidatePath } from "next/cache";
import { act, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";

async function update(userId: string, orgId: string, change: (found: string[], known: string[]) => string[]) {
  const def = getIntegration("aws")!;
  if (!(await integrationLicensed(db(), orgId, def))) throw new Error("AWS needs a business licence: add one in Settings → About.");
  const { config, state } = await loadIntegration(db(), orgId, def);
  const found = ((state as AwsState).exposure?.findings ?? []).map((f) => f.key);
  const acknowledged = change(found, awsAcknowledged(config));
  await saveModule(db(), orgId, def.key, { config: { ...config, options: { ...config.options, acknowledged } } }, { type: "user", id: userId });
  revalidatePath("/settings/integrations/aws");
}

/** Marks one finding (or all of them) as expected, so only new ones are flagged. */
export async function acknowledgeAwsFindingAction(key: string | null, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    let n = 0;
    await update(user.id, user.orgId, (found, known) => {
      const add = key ? found.filter((k) => k === key) : found;
      n = add.filter((k) => !known.includes(k)).length;
      // Only findings still present stay on the list, so one that's fixed and comes back is flagged again.
      return [...new Set([...known, ...add])].filter((k) => found.includes(k)).sort();
    });
    if (!n) throw new Error("Nothing to mark.");
    return `Marked ${n === 1 ? "it" : `${n} findings`} as expected. The monitor clears at the next check (or Sync now).`;
  });
}

export async function forgetAwsFindingAction(key: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    await update(user.id, user.orgId, (_found, known) => known.filter((k) => k !== key));
    return "No longer marked as expected.";
  });
}
