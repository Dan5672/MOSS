"use server";

import { acknowledgedHostnames, getIntegration, loadIntegration, saveModule, type CloudflareState } from "@moss/core";
import { revalidatePath } from "next/cache";
import { act, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";

/** Marks every hostname the last exposure report found as expected (or one, by name), so only new ones are flagged. */
export async function acknowledgeHostnamesAction(name: string | null, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const def = getIntegration("cloudflare")!;
    const { config, state } = await loadIntegration(db(), user.orgId, def);
    const found = ((state as CloudflareState).exposure?.hostnames ?? []).map((h) => h.name);
    const names = name ? found.filter((n) => n === name) : found;
    if (!names.length) throw new Error("Nothing to mark.");
    // Only hostnames still public stay on the list, so one removed and later re-added is flagged again.
    const acknowledged = [...new Set([...acknowledgedHostnames(config), ...names])].filter((n) => found.includes(n)).sort();
    await saveModule(db(), user.orgId, def.key, { config: { ...config, options: { ...config.options, acknowledged } } }, { type: "user", id: user.id });
    revalidatePath("/settings/integrations/cloudflare");
    return `Marked ${names.length === 1 ? names[0] : `${names.length} hostnames`} as expected. The monitor clears at the next check (or Sync now).`;
  });
}

/** Takes a hostname off the expected list, so it's flagged again while it stays public. */
export async function forgetHostnameAction(name: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const def = getIntegration("cloudflare")!;
    const { config } = await loadIntegration(db(), user.orgId, def);
    const acknowledged = acknowledgedHostnames(config).filter((n) => n !== name);
    await saveModule(db(), user.orgId, def.key, { config: { ...config, options: { ...config.options, acknowledged } } }, { type: "user", id: user.id });
    revalidatePath("/settings/integrations/cloudflare");
    return `${name} is no longer marked as expected.`;
  });
}
