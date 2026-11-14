/**
 * Max (workspace): memory retrieval for the "Ask Gomon" memory on/off proof.
 * Voyage embeddings on `memories.embedding` + an Atlas Vector Search index. Rob's agent loop owns the
 * production retrieval (hybrid); this is the same contract (active, team+project scoped) so the two agree.
 */
import type { Db, ObjectId } from "mongodb";

export const VECTOR_INDEX = "memories_vector";
export const DIMS = 1024;

type EmbedFn = (texts: string[], kind: "document" | "query") => Promise<number[][]>;

export const voyageEmbed: EmbedFn = async (texts, kind) => {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is not set");
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ input: texts, model: process.env.VOYAGE_MODEL || "voyage-4", input_type: kind, output_dimension: DIMS }),
    signal: AbortSignal.timeout(15000),
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok || !j?.data) throw new Error(`voyage ${res.status}: ${j?.detail ?? "no data"}`);
  return j.data.map((x: any) => x.embedding as number[]);
};

/** Embed active memories that have no vector yet (new locks, corrections). Returns how many were embedded. */
export async function embedMissing(d: Db, scope: { teamId: string; projectId: string }, embed: EmbedFn = voyageEmbed): Promise<number> {
  const col = d.collection("memories");
  const todo = await col.find({ ...scope, status: "active", embedding: { $exists: false } }, { projection: { text: 1 } }).limit(100).toArray();
  if (!todo.length) return 0;
  const vecs = await embed(todo.map((m) => String(m.text)), "document");
  await col.bulkWrite(todo.map((m, i) => ({ updateOne: { filter: { _id: m._id }, update: { $set: { embedding: vecs[i], embeddingModel: process.env.VOYAGE_MODEL || "voyage-4" } } } })));
  return todo.length;
}

/** Create the vector index if missing. Filter fields keep every query team-scoped and active-only. */
export async function ensureVectorIndex(d: Db): Promise<"exists" | "created"> {
  const col = d.collection("memories");
  const have = await col.listSearchIndexes(VECTOR_INDEX).toArray();
  if (have.length) return "exists";
  await col.createSearchIndex({
    name: VECTOR_INDEX, type: "vectorSearch",
    definition: { fields: [
      { type: "vector", path: "embedding", numDimensions: DIMS, similarity: "cosine" },
      { type: "filter", path: "status" }, { type: "filter", path: "teamId" }, { type: "filter", path: "projectId" },
    ] },
  } as any);
  return "created";
}

export type Hit = { _id: ObjectId; key?: string; kind?: string; text: string; version?: number; score: number };

export async function retrieve(d: Db, scope: { teamId: string; projectId: string }, question: string, k = 4, embed: EmbedFn = voyageEmbed): Promise<Hit[]> {
  const [qv] = await embed([question], "query");
  return d.collection("memories").aggregate<Hit>([
    { $vectorSearch: { index: VECTOR_INDEX, path: "embedding", queryVector: qv, numCandidates: 100, limit: k,
        filter: { status: "active", teamId: scope.teamId, projectId: scope.projectId } } },
    { $project: { key: 1, kind: 1, text: 1, version: 1, score: { $meta: "vectorSearchScore" } } },
  ]).toArray();
}
