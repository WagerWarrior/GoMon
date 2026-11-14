/**
 * Thin proxy to the worker for template, call, meeting and project writes. The worker owns the policy checks
 * (manage_templates, start_meeting, create_project) and the audit rows; this route only forwards allowed paths with
 * WORKER_TOKEN, plus a signed-in user's `x-session-token` when the browser sends one.
 */
export const dynamic = "force-dynamic";
const ALLOWED = /^(templates(\/[\w-]+)?|calls\/[\w.:-]+|meetings(\/[\w.:-]+\/leave)?|projects)$/;

async function forward(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join("/");
  if (!ALLOWED.test(path)) return Response.json({ error: "not allowed" }, { status: 404 });
  const base = process.env.WORKER_URL || "http://localhost:3001";
  const session = req.headers.get("x-session-token");
  try {
    const r = await fetch(`${base}/api/${path}`, {
      method: req.method, body: req.method === "GET" ? undefined : await req.text(),
      headers: {
        "content-type": "application/json",
        ...(process.env.WORKER_TOKEN ? { authorization: `Bearer ${process.env.WORKER_TOKEN}` } : {}),
        ...(session ? { "x-session-token": session } : {}),
      },
      // Starting a meeting waits for Recall to accept the bot.
      signal: AbortSignal.timeout(path.startsWith("meetings") ? 25_000 : 6000),
    });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: `Worker not reachable at ${base}. Start apps/worker or set WORKER_URL.` }, { status: 502 });
  }
}
export { forward as GET, forward as POST, forward as PUT, forward as PATCH };
