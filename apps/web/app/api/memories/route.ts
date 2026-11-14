import { db, scope } from "@/lib/db";
export const dynamic = "force-dynamic";

/** Find active team memories by key or words (composer "Add from database"). Team, project and status filtered. */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 80);
  const d = await db(); const { teamId, projectId } = scope();
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter: any = { teamId, projectId, status: "active", ...(q ? { $or: [{ key: { $regex: `^${esc}`, $options: "i" } }, { text: { $regex: esc, $options: "i" } }] } : {}) };
  const rows = await d.collection("memories").find(filter, { projection: { key: 1, kind: 1, text: 1 } }).sort({ updatedAt: -1, _id: -1 }).limit(8).toArray();
  return Response.json({ rows: rows.map((m) => ({ id: String(m._id), key: m.key ?? null, kind: m.kind, text: m.text })) });
}
