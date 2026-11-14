import { db, scope } from "@/lib/db";
import { embedMissing, retrieve } from "@/lib/retrieval";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Max (workspace): "Ask Gomon" with memory on or off, the spec's proof that memory changes behaviour.
 * Memory on: Atlas Vector Search over active, team-scoped memories; the answer cites the memory IDs it used.
 * Memory off: no retrieval, nothing cited. Each ask is written to audit_events so the trail lives in Atlas.
 */
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const { question, memory, callId, actor } = b as { question?: string; memory?: boolean; callId?: string; actor?: string };
  if (!question?.trim()) return Response.json({ error: "question required" }, { status: 400 });
  const d = await db(); const sc = scope(); const started = Date.now();
  let hits: Awaited<ReturnType<typeof retrieve>> = [];
  try {
    if (memory) { await embedMissing(d, sc); hits = await retrieve(d, sc, question.trim()); }
  } catch (e: any) {
    return Response.json({ error: `retrieval failed: ${e?.message ?? e}` }, { status: 502 });
  }
  const answer = memory
    ? hits.length ? `From team memory: ${hits[0].text}` : "Team memory has nothing on this yet."
    : "Memory is off: answering without team context, so no stored decision is checked or cited.";
  const ms = Date.now() - started;
  await d.collection("audit_events").insertOne({
    callId, ...sc, at: new Date(), type: memory ? "ask_memory_on" : "ask_memory_off", actor: actor || "workspace",
    reason: question.trim().slice(0, 200), ref: { memoryIds: hits.map((h) => String(h._id)), ms },
  });
  return Response.json({ answer, memory: !!memory, ms, cited: hits.map((h) => ({ id: String(h._id), key: h.key, kind: h.kind, version: h.version, text: h.text, score: Number(h.score.toFixed(3)) })) });
}
