import "server-only";
import { refresh } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

export type ActionState = { ok?: boolean; error?: string; message?: string; needTotp?: boolean } | undefined;

/**
 * Runs a server action body, turning thrown errors into a displayable message and refreshing
 * the page on success. redirect()/notFound() pass through.
 */
export async function act(fn: () => Promise<string | void>): Promise<ActionState> {
  try {
    const message = await fn();
    refresh();
    return { ok: true, message: message || undefined };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof z.ZodError) return { error: z.prettifyError(err) };
    return { error: err instanceof Error ? err.message : "Something went wrong" };
  }
}

/** Reads FormData into an object for zod parsing (empty strings become undefined). */
export function formObject(form: FormData): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") out[k] = v.trim() === "" ? undefined : v;
  }
  return out;
}
