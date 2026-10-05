"use server";

import { writeAudit } from "@moss/core";
import { models, providers } from "@moss/db";
import { KNOWN_PRICING } from "@moss/llm";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";
import { storeSecret } from "@/server/services";

const providerSchema = z
  .object({
    kind: z.enum(["anthropic", "openai", "openrouter", "ollama", "openai_compatible", "claude_code"]),
    name: z.string().min(1).max(60),
    baseUrl: z.url("Enter a full URL, e.g. http://192.168.1.20:11434/v1").optional(),
    apiKey: z.string().min(8).max(500).optional(),
  })
  .refine((p) => p.kind === "ollama" || p.kind === "openai_compatible" || p.apiKey, {
    message: "This provider needs an API key (for a Claude subscription, the token from claude setup-token)",
    path: ["apiKey"],
  })
  .refine((p) => (p.kind !== "ollama" && p.kind !== "openai_compatible") || p.baseUrl, { message: "This provider needs a base URL", path: ["baseUrl"] });

export async function addProviderAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("models.manage");
    const p = providerSchema.parse(formObject(form));
    let apiKeySecretId: string | null = null;
    if (p.apiKey) {
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || p.kind;
      // Stored via the gate: the web app never holds the encryption key, and the value is never read back.
      const what = p.kind === "claude_code" ? "Claude subscription token" : "API key";
      apiKeySecretId = await storeSecret({ userId: user.id, name: `llm-${slug}-api-key`, type: "api_token", value: p.apiKey, description: `${what} for ${p.name}` });
    }
    const [row] = await db()
      .insert(providers)
      .values({ orgId: user.orgId, kind: p.kind, name: p.name, baseUrl: p.baseUrl ?? null, apiKeySecretId })
      .returning();
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "provider.add", targetType: "provider", targetId: row!.id, details: { kind: p.kind, name: p.name, baseUrl: p.baseUrl } });
    return `Added ${p.name}.`;
  });
}

const modelSchema = z.object({
  providerId: z.uuid("Choose a provider"),
  modelId: z.string().min(1).max(120),
  displayName: z.string().max(120).optional(),
  inputPrice: z.coerce.number().min(0).optional(),
  outputPrice: z.coerce.number().min(0).optional(),
});

export async function addModelAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("models.manage");
    const m = modelSchema.parse(formObject(form));
    const [provider] = await db().select().from(providers).where(and(eq(providers.id, m.providerId), eq(providers.orgId, user.orgId)));
    if (!provider) throw new Error("Unknown provider");
    // A subscription has no per-token price; usage is still counted in tokens.
    const known = provider.kind === "claude_code" ? undefined : KNOWN_PRICING[m.modelId];
    const price = (v: number | undefined, fallback: number | undefined) => String(provider.kind === "claude_code" ? 0 : (v ?? fallback ?? 0));
    const [row] = await db()
      .insert(models)
      .values({
        orgId: user.orgId,
        providerId: provider.id,
        modelId: m.modelId,
        displayName: m.displayName ?? m.modelId,
        inputPricePerMTok: price(m.inputPrice, known?.input),
        outputPricePerMTok: price(m.outputPrice, known?.output),
        cacheReadPricePerMTok: price(undefined, known?.cacheRead),
        cacheWritePricePerMTok: price(undefined, known?.cacheWrite),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new Error("That model is already added for this provider");
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "model.add", targetType: "model", targetId: row.id, details: { modelId: m.modelId } });
    return `Added ${row.displayName}.`;
  });
}

const pricingSchema = z.object({
  inputPrice: z.coerce.number().min(0),
  outputPrice: z.coerce.number().min(0),
  cacheReadPrice: z.coerce.number().min(0),
  cacheWritePrice: z.coerce.number().min(0),
});

export async function updateModelPricingAction(modelId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("models.manage");
    const p = pricingSchema.parse(formObject(form));
    const [row] = await db()
      .select({ model: models, providerKind: providers.kind })
      .from(models)
      .innerJoin(providers, eq(providers.id, models.providerId))
      .where(and(eq(models.id, modelId), eq(models.orgId, user.orgId)));
    if (!row) throw new Error("Unknown model");
    // Runs on a subscription are never priced, so a price here would have no effect.
    if (row.providerKind === "claude_code") throw new Error("Models on a Claude subscription have no per-token price");
    const next = {
      inputPricePerMTok: String(p.inputPrice),
      outputPricePerMTok: String(p.outputPrice),
      cacheReadPricePerMTok: String(p.cacheReadPrice),
      cacheWritePricePerMTok: String(p.cacheWritePrice),
    };
    await db().update(models).set(next).where(eq(models.id, modelId));
    const { inputPricePerMTok, outputPricePerMTok, cacheReadPricePerMTok, cacheWritePricePerMTok } = row.model;
    await writeAudit(db(), {
      orgId: user.orgId,
      actorType: "user",
      actorId: user.id,
      action: "model.update_pricing",
      targetType: "model",
      targetId: modelId,
      details: { modelId: row.model.modelId, from: { inputPricePerMTok, outputPricePerMTok, cacheReadPricePerMTok, cacheWritePricePerMTok }, to: next },
    });
    return `Prices updated for ${row.model.displayName}. They apply from the next run.`;
  });
}

export async function toggleModelAction(modelId: string, enabled: boolean, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("models.manage");
    await db().update(models).set({ enabled }).where(and(eq(models.id, modelId), eq(models.orgId, user.orgId)));
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: enabled ? "model.enable" : "model.disable", targetType: "model", targetId: modelId });
    return enabled ? "Model enabled." : "Model disabled.";
  });
}
