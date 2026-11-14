/**
 * Thin proxy to the worker for template and call writes (POST/PUT/PATCH). The worker owns the policy check
 * (manage_templates, template_assigned audit); this route only forwards with WORKER_TOKEN and allows two paths.
 */
export const dynamic = "force-dynamic";
const ALLOWED = /^(templates(\/[\w-]+)?|calls\/[\w.:-]+)$/;

async function forward(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join("/");
  if (!ALLOWED.test(path)) return Response.json({ error: "not allowed" }, { status: 404 });
  const base = process.env.WORKER_URL || "http://localhost:3001";
  try {
    const r = await fetch(`${base}/api/${path}`, {
      method: req.method, body: req.method === "GET" ? undefined : await req.text(),
      headers: { "content-type": "application/json", ...(process.env.WORKER_TOKEN ? { authorization: `Bearer ${process.env.WORKER_TOKEN}` } : {}) },
      signal: AbortSignal.timeout(6000),
    });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: `Worker not reachable at ${base}. Start apps/worker or set WORKER_URL.` }, { status: 502 });
  }
}
export { forward as GET, forward as POST, forward as PUT, forward as PATCH };
