import { db, scope } from "@/lib/db";
import { CATEGORIES } from "@/lib/categories";
export const dynamic = "force-dynamic";

/** Set a session's category ({ category }). Only the known list is accepted; the change is audited. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const callId = decodeURIComponent(id);
  const { category, actor } = (await req.json().catch(() => ({}))) as { category?: string; actor?: string };
  if (!category || !CATEGORIES.includes(category)) return Response.json({ error: `category must be one of ${CATEGORIES.join(", ")}` }, { status: 400 });
  const d = await db(); const sc = scope();
  const r = await d.collection("calls").updateOne({ _id: callId as any }, { $set: { category, updatedAt: new Date() } });
  if (!r.matchedCount) return Response.json({ error: "no such session" }, { status: 404 });
  await d.collection("audit_events").insertOne({ ...sc, callId, at: new Date(), type: "session_categorized", actor: actor || "workspace", reason: category });
  return Response.json({ ok: true, category });
}
