// The agent library's part that decides what agents may do: built-in skills (and the tools they grant), the core
// skills every agent gets, and Moss itself. Kept in step here, by the gate, because the worker's database role
// can't write skills, grants or agents (packages/db/src/roles.ts).
import { ensureCoreSkills, ensureMoss, loadLibrary, MOSS_TEMPLATE, syncBuiltInSkills } from "@moss/agent/library";
import { orgs, type Database } from "@moss/db";

type Log = (msg: string, extra?: Record<string, unknown>) => void;

export async function startLibrarySync(db: Database, libraryDir: string, log: Log, everyMs = 60_000) {
  const lib = await loadLibrary(libraryDir).catch((err: Error) => {
    log("library not loaded", { error: err.message });
    return null;
  });
  if (!lib) return;
  for (const org of await db.select({ id: orgs.id }).from(orgs)) await syncBuiltInSkills(db, org.id, lib.skills.values());
  log("library synced", { skills: lib.skills.size, templates: lib.templates.size });
  const tick = async () => {
    try {
      for (const org of await db.select({ id: orgs.id }).from(orgs)) {
        // Every install has a Moss, the expert on MOSS itself, once there is a model to run it on.
        const id = await ensureMoss(db, org.id, lib.templates.get(MOSS_TEMPLATE));
        if (id) log("hired Moss", { orgId: org.id, agentId: id });
        // Agents hired since the last tick get the core skills too (hiring adds them; this is the backstop).
        const added = await ensureCoreSkills(db, org.id);
        if (added) log("core skills given", { orgId: org.id, added });
      }
    } catch (err) {
      log("library sync failed", { error: (err as Error).message });
    }
  };
  await tick();
  setInterval(tick, everyMs).unref();
}
