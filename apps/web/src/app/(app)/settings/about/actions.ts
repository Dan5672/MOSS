"use server";

import { compareRelease, setSetting } from "@moss/core";
import { act, type ActionState } from "@/server/action";
import { requireUser } from "@/server/auth";
import { config } from "@/server/config";
import { db } from "@/server/db";

/** Asks GitHub (through the gate and the toolbox) for MOSS's newest release, and keeps the answer for the page. */
export async function checkForUpdatesAction(_: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    let body: { ok?: boolean; tags?: string[]; error?: string };
    try {
      const res = await fetch(`${config.gateUrl()}/v1/web/releases`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.webToken()}` },
        body: JSON.stringify({ userId: user.id }),
        signal: AbortSignal.timeout(30_000),
      });
      body = (await res.json().catch(() => ({}))) as typeof body;
    } catch (err) {
      throw new Error(`The gate is unavailable: ${(err as Error).message}`);
    }
    if (!body.ok || !body.tags) throw new Error(`Couldn't check: ${body.error ?? "no answer from GitHub"}`);
    const check = compareRelease(process.env.MOSS_RELEASE ?? "dev", body.tags);
    await setSetting(db(), user.orgId, "moss.update_check", { ...check, at: new Date().toISOString() });
    switch (check.status) {
      case "update":
        return `MOSS ${check.latest} is out (you have ${check.running}).`;
      case "current":
        return `MOSS is up to date (${check.running}).`;
      case "ahead":
        return `You're on a development build (${check.running}), newer than the latest release${check.latest ? ` (${check.latest})` : ""}.`;
      default:
        return check.latest ? `The newest release is ${check.latest}; this install's version isn't recorded, so it can't be compared.` : "No MOSS releases were found.";
    }
  });
}
