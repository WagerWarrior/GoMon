import { callScope, db } from "@/lib/db";
import { isKeyQuery, originLabel, type Hit, type Source } from "@/lib/context";
export const dynamic = "force-dynamic";

const COMPANY = "company";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const day = (d?: Date) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : undefined);
const hm = (d?: Date) => (d ? new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : undefined);

/**
 * Quotable context for the composer, read with the worker's scope: the call's project plus company context,
 * active memory only, always filtered by team. Memory search uses the Atlas vector index (automated embedding)
 * for words and a key prefix for keys like D-13.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const src = (u.searchParams.get("src") ?? "memory") as Source;
  const q = (u.searchParams.get("q") ?? "").trim().slice(0, 120);
  const callId = u.searchParams.get("callId") ?? undefined;
  const d = await db(); const { teamId, projectId } = await callScope(callId);
  const projects = projectId === COMPANY ? [COMPANY] : [projectId, COMPANY];
  const rx = q ? { $regex: esc(q), $options: "i" } : undefined;
  let rows: Hit[] = []; let mode = "recent";

  if (src === "memory") {
    const base = { teamId, projectId: { $in: projects }, status: "active" };
    const toHit = (m: any): Hit => ({ src, id: String(m._id), title: m.key ?? m.kind, tag: String(m.kind).replace(/_/g, " "), meta: [originLabel(m.origin), m.projectId === COMPANY ? "company" : undefined].filter(Boolean).join(" · "), text: m.text, score: m.s });
    if (q && !isKeyQuery(q)) {
      try {
        const hits = await d.collection("memories").aggregate([
          { $vectorSearch: { index: "memories_auto", path: "text", query: { text: q }, numCandidates: 80, limit: 10, filter: base } },
          { $project: { key: 1, kind: 1, origin: 1, projectId: 1, text: 1, s: { $meta: "vectorSearchScore" } } },
        ]).toArray();
        rows = hits.map(toHit); mode = "meaning";
      } catch { /* index not available on this cluster: fall back to words */ }
    }
    if (mode !== "meaning") {
      const filter = q ? { ...base, $or: [{ key: { $regex: `^${esc(q)}`, $options: "i" } }, { text: rx }] } : base;
      rows = (await d.collection("memories").find(filter, { projection: { key: 1, kind: 1, origin: 1, projectId: 1, text: 1 } }).sort({ key: 1 }).limit(40).toArray()).map(toHit);
      mode = q ? (isKeyQuery(q) ? "key" : "words") : "all";
    }
  } else if (src === "items" && callId) {
    const items = await d.collection("call_items").find({ teamId, callId, ...(rx ? { text: rx } : {}) }, { projection: { kind: 1, text: 1, status: 1 } }).sort({ createdAt: -1 }).limit(30).toArray();
    rows = items.map((i: any) => ({ src, id: String(i._id), title: String(i.kind).replace(/_/g, " "), tag: i.status === "promoted" ? "locked" : i.status === "rejected" ? "vetoed" : i.status, text: i.text }));
  } else if (src === "quotes" && callId) {
    const us = await d.collection("utterances").find({ teamId, callId, ...(rx ? { text: rx } : {}), "speaker.displayName": { $nin: ["Gomon", "Mission control"] } }, { projection: { speaker: 1, text: 1, receivedAt: 1 } }).sort({ seq: -1 }).limit(30).toArray();
    rows = us.map((x: any) => ({ src, id: String(x._id), title: x.speaker?.displayName ?? "Someone", meta: hm(x.receivedAt), text: x.text }));
  } else if (src === "meetings") {
    const calls = await d.collection<any>("calls").find({ teamId, projectId: { $in: projects }, _id: { $ne: callId }, summary: { $nin: [null, ""] }, ...(rx ? { $or: [{ title: rx }, { summary: rx }] } : {}) }, { projection: { title: 1, summary: 1, startedAt: 1 } }).sort({ startedAt: -1 }).limit(20).toArray();
    rows = calls.map((c: any) => ({ src, id: String(c._id), title: c.title ?? c._id, meta: day(c.startedAt), text: c.summary }));
  }
  return Response.json({ rows, mode, scope: { teamId, projects } });
}
