// Downloads a config backup. Only the gate holds the master key, so it decrypts the file and audits the
// download; this route checks the person may see backups (they can contain passwords) and passes it on.
import { config } from "@/server/config";
import { getCurrentUser } from "@/server/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: RouteContext<"/api/backups/[id]">) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in first" }, { status: 401 });
  if (!user.permissions.has("secrets.manage")) return Response.json({ error: "Downloading backups needs the secrets.manage permission" }, { status: 403 });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "Invalid backup id" }, { status: 400 });

  const res = await fetch(`${config.gateUrl()}/v1/backups/${id}?userId=${user.id}`, {
    headers: { authorization: `Bearer ${config.webToken()}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return Response.json({ error: "No such backup" }, { status: 404 });
  if (!res.ok) return Response.json({ error: `The gate refused (HTTP ${res.status})` }, { status: 502 });
  return new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": res.headers.get("content-disposition") ?? "attachment",
      "cache-control": "no-store",
    },
  });
}
