/**
 * Proxy for the in-app listener (components/platform/Listen.tsx): a single-use ElevenLabs Scribe token and committed
 * transcript segments go to the worker's loopback-only /ears routes (echo + duplicate guards live there).
 */
export const dynamic = "force-dynamic";
const ALLOWED = /^(token|utterance|active)$/;

async function forward(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join("/");
  if (!ALLOWED.test(path)) return Response.json({ error: "not allowed" }, { status: 404 });
  const base = process.env.WORKER_URL || "http://localhost:3001";
  try {
    const r = await fetch(`${base}/ears/${path}`, {
      method: req.method, body: req.method === "GET" ? undefined : await req.text(),
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
    });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: `Worker not reachable at ${base}` }, { status: 502 });
  }
}
export { forward as GET, forward as POST };
