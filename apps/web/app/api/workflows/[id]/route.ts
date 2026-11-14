import { setWorkflowEnabled } from "@/lib/workflows";
export const dynamic = "force-dynamic";
/** PATCH { enabled, actor } turns a stored workflow on or off (audited). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const b = await req.json().catch(() => ({}));
  if (typeof b.enabled !== "boolean") return Response.json({ error: "enabled must be true or false" }, { status: 400 });
  const ok = await setWorkflowEnabled((await params).id, b.enabled, String(b.actor ?? "Max"));
  return ok ? Response.json({ ok: true }) : Response.json({ error: "unknown workflow" }, { status: 404 });
}
