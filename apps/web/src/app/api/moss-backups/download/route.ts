// Streams a MOSS backup, encrypted with the passphrase given when the one-time ticket was issued (Settings →
// Backups checks a fresh two-factor code first). The backup service does the encrypting.
import { getCurrentUser } from "@/server/auth";
import { encryptedBackup, redeemDownloadTicket } from "@/server/backup-service";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in first" }, { status: 401 });
  const ticket = new URL(req.url).searchParams.get("ticket") ?? "";
  const grant = redeemDownloadTicket(ticket, user.id);
  if (!grant) return Response.json({ error: "That download link has expired. Start the download again." }, { status: 410 });
  try {
    const res = await encryptedBackup(grant.name, grant.passphrase);
    return new Response(res.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${grant.name}.enc"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "The backup service failed" }, { status: 502 });
  }
}
