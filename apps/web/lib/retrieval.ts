/**
 * Max (workspace): memory retrieval for "Ask Gomon". This is Rob's hybrid retrieval (apps/worker/src/retrieve.ts),
 * ported so the workspace and the voice agent rank memories the same way, on the same Atlas indexes:
 *  - memories_auto: Vector Search with Atlas Automated Embedding (Atlas embeds `text` and the query with Voyage)
 *  - memories_text: Atlas Search (lexical, so "R-12" matches)
 * fused with $rankFusion, all pre-filtered to team, project and active. Exact keys and very fresh memories are added
 * straight from the collection (the search index tails the oplog). Indexes are created by `apps/worker npm run setup`.
 */
import type { Db, ObjectId } from "mongodb";

export const INDEX = { vector: "memories_auto", text: "memories_text" } as const;
const FRESH_MS = 60_000;

export type Hit = { _id: ObjectId; key?: string; kind?: string; text: string; version?: number; origin?: string; score: number; via: string[] };
type Scope = { teamId: string; projectId: string };

/** Explicit IDs in a question ("R-12", "d 09") as stored keys. */
export function keysIn(q: string): string[] {
  return [...new Set([...q.matchAll(/\b([a-z])[\s-]?(\d{1,3})\b/gi)].map((m) => `${m[1].toUpperCase()}-${m[2].padStart(2, "0")}`))];
}

/** Keyed hits first, then fused search hits, then fresh ones the index has not caught yet. No duplicates. */
export function merge(fused: Hit[], exact: Hit[], fresh: Hit[]): Hit[] {
  const out = fused.map((h) => ({ ...h, via: [...h.via] }));
  const keyed: Hit[] = []; const late: Hit[] = [];
  for (const m of exact) {
    const i = out.findIndex((r) => String(r._id) === String(m._id));
    if (i >= 0) { const [h] = out.splice(i, 1); keyed.push({ ...h, via: [...h.via, "key"] }); }
    else if (!keyed.some((r) => String(r._id) === String(m._id))) keyed.push({ ...m, score: 0, via: ["key"] });
  }
  for (const m of fresh) {
    const seen = [...keyed, ...out, ...late].some((r) => String(r._id) === String(m._id));
    if (!seen) late.push({ ...m, score: 0, via: ["fresh"] });
  }
  return [...keyed, ...out, ...late];
}

export async function retrieve(d: Db, scope: Scope, question: string, k = 4, embedModel = process.env.EMBED_MODEL || "voyage-4"): Promise<Hit[]> {
  const filter = { teamId: scope.teamId, projectId: scope.projectId, status: "active" };
  const proj = { key: 1, kind: 1, text: 1, origin: 1, version: 1 };
  const col = d.collection("memories");
  const fusedRaw = await col.aggregate<any>([
    { $rankFusion: {
        input: { pipelines: {
          vector: [{ $vectorSearch: { index: INDEX.vector, path: "text", query: question, model: embedModel, numCandidates: 150, limit: 12, filter } }],
          text: [{ $search: { index: INDEX.text, compound: {
            must: [{ text: { query: question, path: ["text", "key"] } }],
            filter: [{ equals: { path: "teamId", value: scope.teamId } }, { equals: { path: "projectId", value: scope.projectId } }, { equals: { path: "status", value: "active" } }],
          } } }, { $limit: 12 }],
        } },
        combination: { weights: { vector: 1, text: 1 } }, scoreDetails: true } },
    { $limit: k },
    { $project: { ...proj, score: { $meta: "score" }, details: { $meta: "scoreDetails" } } },
  ]).toArray();
  const fused: Hit[] = fusedRaw.map(({ details, ...m }) => ({ ...m, via: (details?.details ?? []).filter((x: any) => typeof x.rank === "number").map((x: any) => x.inputPipelineName) }));
  const keys = keysIn(question);
  const exact = keys.length ? ((await col.find({ ...filter, key: { $in: keys } }, { projection: proj }).toArray()) as any as Hit[]) : [];
  const fresh = (await col.find({ ...filter, updatedAt: { $gte: new Date(Date.now() - FRESH_MS) } }, { projection: proj }).limit(5).toArray()) as any as Hit[];
  return merge(fused, exact, fresh).slice(0, Math.max(k, keys.length));
}
