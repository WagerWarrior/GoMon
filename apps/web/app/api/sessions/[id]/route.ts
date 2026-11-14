import { db, scope } from "@/lib/db";
import { CATEGORIES } from "@/lib/categories";
import { timeline } from "@/lib/timeline";
export const dynamic = "force-dynamic";

/** Set a session's category ({ category }). Only the known list is accepted; the change is audited. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const callId = decodeURIComponent(id);
  const { category, templateId, actor } = (await req.json().catch(() => ({}))) as { category?: string; templateId?: string; actor?: string };
  if (templateId) {
    // How Gomon behaves in this call. The worker reads calls.templateId on every run, so this applies within seconds.
    const d = await db(); const sc = scope();
    if (!(await d.collection("agent_templates").findOne({ _id: templateId as any, teamId: sc.teamId }))) return Response.json({ error: "unknown template" }, { status: 400 });
    const r = await d.collection("calls").updateOne({ _id: callId as any }, { $set: { templateId, updatedAt: new Date() } });
    if (!r.matchedCount) return Response.json({ error: "no such session" }, { status: 404 });
    await d.collection("audit_events").insertOne({ ...sc, callId, at: new Date(), type: "template_set", actor: actor || "workspace", reason: templateId });
    return Response.json({ ok: true, templateId });
  }
  if (!category || !CATEGORIES.includes(category)) return Response.json({ error: `category must be one of ${CATEGORIES.join(", ")}` }, { status: 400 });
  const d = await db(); const sc = scope();
  const r = await d.collection("calls").updateOne({ _id: callId as any }, { $set: { category, updatedAt: new Date() } });
  if (!r.matchedCount) return Response.json({ error: "no such session" }, { status: 404 });
  await d.collection("audit_events").insertOne({ ...sc, callId, at: new Date(), type: "session_categorized", actor: actor || "workspace", reason: category });
  return Response.json({ ok: true, category });
}

/** The session as a chat timeline (people, Gomon, and Gomon's work inline). Polled by the Live view. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return Response.json({ now: new Date().toISOString(), entries: await timeline(decodeURIComponent(id)) });
}
