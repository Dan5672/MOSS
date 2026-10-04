"use server";

import { addAsset, setAssetLocked, updateAsset, writeAudit } from "@moss/core";
import { assets } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";

const kind = z.string().regex(/^[a-z_]{2,32}$/, "Use lowercase letters and underscores");

export async function updateAssetAction(assetId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("assets.manage");
    const patch = z
      .object({
        name: z.string().min(1).max(100),
        kind,
        vendor: z.string().max(100).optional(),
        model: z.string().max(100).optional(),
        os: z.string().max(100).optional(),
        notes: z.string().max(2000).optional(),
      })
      .parse(formObject(form));
    // A human edit is authoritative.
    await updateAsset(db(), user.orgId, assetId, { ...patch, confidence: 100 }, { type: "user", id: user.id });
    return "Saved.";
  });
}

export async function lockAssetAction(assetId: string, locked: boolean, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("assets.manage");
    await setAssetLocked(db(), user.orgId, assetId, locked, user.id);
    return locked ? "Locked: agents can no longer change this asset." : "Unlocked.";
  });
}

export async function retireAssetAction(assetId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("assets.manage");
    await db().update(assets).set({ status: "retired", updatedAt: new Date() }).where(and(eq(assets.id, assetId), eq(assets.orgId, user.orgId)));
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "asset.retire", targetType: "asset", targetId: assetId });
    return "Asset retired.";
  });
}

export async function addAssetAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("assets.manage");
    const input = z
      .object({
        name: z.string().min(1).max(100),
        kind: kind.optional(),
        ip: z.string().max(64).optional(),
        mac: z.string().regex(/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/, "Enter a MAC like aa:bb:cc:dd:ee:ff").optional(),
        notes: z.string().max(2000).optional(),
      })
      .parse(formObject(form));
    await addAsset(db(), user.orgId, input, { type: "user", id: user.id });
    return `Added ${input.name}.`;
  });
}
