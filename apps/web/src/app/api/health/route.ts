// Liveness probe for the container healthcheck. No database access, no auth.
export function GET() {
  return Response.json({ ok: true });
}
