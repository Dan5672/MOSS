"use server";

import { syncBuiltInSkills } from "@moss/agent";
import { bootstrapOrg, MIN_PASSWORD_LENGTH } from "@moss/core";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/server/action";
import { formObject } from "@/server/action";
import { endSession, isSetUp, login, startSession } from "@/server/auth";
import { db } from "@/server/db";
import { library } from "@/server/services";

const setupSchema = z
  .object({
    orgName: z.string().min(1, "Give your network a name").max(100),
    ownerName: z.string().min(1, "Enter your name").max(100),
    ownerEmail: z.email("Enter a valid email"),
    ownerPassword: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`).max(200),
    confirmPassword: z.string(),
    accept: z.literal("on", { error: "Confirm that you may scan and manage this network" }),
  })
  .refine((v) => v.ownerPassword === v.confirmPassword, { message: "Passwords don't match", path: ["confirmPassword"] });

export async function setupAction(_: ActionState, form: FormData): Promise<ActionState> {
  if (await isSetUp()) redirect("/login");
  const parsed = setupSchema.safeParse(formObject(form));
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("\n") };
  const { org, owner } = await bootstrapOrg(db(), parsed.data);
  await syncBuiltInSkills(db(), org.id, (await library()).skills.values());
  await startSession(owner.id);
  redirect("/");
}

export async function loginAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { email, password, code } = formObject(form);
  if (!email || !password) return { error: "Enter your email and password." };
  const res = await login(email, password, code);
  if (!res.ok) return { error: res.error, needTotp: res.needTotp };
  redirect("/");
}

export async function logoutAction() {
  await endSession();
  redirect("/login");
}
