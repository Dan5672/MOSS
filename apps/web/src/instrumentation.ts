// Before the first request: put this process in Settings' time zone, so the first page after a restart isn't in
// UTC (each page also re-applies it, from the app layout).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const [{ applyOrgTimeZone }, { orgs }, { db }] = await Promise.all([import("@moss/core"), import("@moss/db"), import("@/server/db")]);
    const [org] = await db().select({ id: orgs.id }).from(orgs).limit(1);
    if (org) await applyOrgTimeZone(db(), org.id);
  } catch (err) {
    console.warn(JSON.stringify({ msg: "time zone not applied at startup", error: (err as Error).message }));
  }
}
