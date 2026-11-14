import type { ObjectId } from "mongodb";
import { config, INDEX } from "./config.ts";
import type { Cols } from "./db.ts";
import type { ItemKind, Memory } from "./shapes.ts";
import { memoryFilter, readableProjects } from "./scope.ts";

export type Scope = { teamId: string; projectId: string };
export type Retrieved = {
  _id: ObjectId; key?: string; kind: ItemKind; text: string; origin: Memory["origin"]; version: number; projectId?: string;
  score: number; via: string[];
};

/** Memories promoted in the last minute may not be in the search index yet (it tails the oplog). */
const FRESH_MS = 60_000;

type Fused = Retrieved & { details?: { details?: { inputPipelineName: string; rank: unknown }[] } };

/**
 * Atlas hybrid retrieval: $rankFusion over $vectorSearch (Atlas Automated Embedding: Atlas embeds the query text with
 * Voyage server-side) and $search (lexical, so "R-12" matches), both pre-filtered to the caller's team, active status and
 * readable projects (the call's project plus company context). Another team's memory can never be returned: the filter is
 * part of both index queries, not a post-filter.
 */
export async function retrieve(c: Cols, scope: Scope, query: string, limit = 6): Promise<Retrieved[]> {
  const filter = memoryFilter(scope);
  const pipeline = [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [{ $vectorSearch: { index: INDEX.vector, path: "text", query, model: config.embedModel, numCandidates: 150, limit: 12, filter } }],
            text: [
              {
                $search: {
                  index: INDEX.text,
                  compound: {
                    must: [{ text: { query, path: ["text", "key"] } }],
                    filter: [
                      { equals: { path: "teamId", value: scope.teamId } },
                      { in: { path: "projectId", value: readableProjects(scope.projectId) } },
                      { equals: { path: "status", value: "active" } },
                    ],
                  },
                },
              },
              { $limit: 12 },
            ],
          },
        },
        combination: { weights: { vector: 1, text: 1 } },
        scoreDetails: true,
      },
    },
    { $limit: limit },
    { $project: { key: 1, kind: 1, text: 1, origin: 1, version: 1, projectId: 1, score: { $meta: "score" }, details: { $meta: "scoreDetails" } } },
  ];
  const fused = await c.memories.aggregate<Fused>(pipeline).toArray();
  const out: Retrieved[] = fused.map(({ details, ...m }) => ({
    ...m,
    via: (details?.details ?? []).filter((d) => typeof d.rank === "number").map((d) => d.inputPipelineName),
  }));

  // Explicit IDs ("R-12", "d 09") resolve exactly (keys are unique per team) and rank first.
  const keys = [...new Set([...query.matchAll(/\b([a-z])[\s-]?(\d{1,3})\b/gi)].map((m) => `${m[1].toUpperCase()}-${m[2].padStart(2, "0")}`))];
  const exact = keys.length
    ? await c.memories.find({ ...filter, key: { $in: keys } }, { projection: { key: 1, kind: 1, text: 1, origin: 1, version: 1, projectId: 1 } }).toArray()
    : [];
  // Index-lag guard: include very recently promoted/corrected memories straight from the collection.
  const fresh = await c.memories
    .find({ ...filter, updatedAt: { $gte: new Date(Date.now() - FRESH_MS) } }, { projection: { key: 1, kind: 1, text: 1, origin: 1, version: 1, projectId: 1 } })
    .limit(5).toArray();
  const direct: Retrieved[] = [];
  for (const [via, docs] of [["key", exact], ["fresh", fresh]] as const) {
    for (const m of docs) {
      if (!m._id) continue;
      const i = out.findIndex((r) => String(r._id) === String(m._id));
      if (i >= 0) {
        if (via === "key") {
          const [hit] = out.splice(i, 1);
          direct.push({ ...hit, via: [...hit.via, "key"] });
        }
        continue;
      }
      if (direct.some((r) => String(r._id) === String(m._id))) continue;
      direct.push({ _id: m._id, key: m.key, kind: m.kind, text: m.text, origin: m.origin, version: m.version, projectId: m.projectId, score: 0, via: [via] });
    }
  }
  const keyed = direct.filter((r) => r.via.includes("key"));
  return [...keyed, ...out, ...direct.filter((r) => !r.via.includes("key"))];
}
