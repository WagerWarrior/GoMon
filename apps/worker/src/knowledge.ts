/**
 * Atlas as Gomon's knowledge base, beyond canonical memory:
 *  - `artifacts`: an ADR document per locked decision (structured fields + markdown `text`), embedded by Atlas (artifacts_auto).
 *  - semantic search over past meeting transcripts (utterances_auto on `utterances.text`), meeting summaries (calls_auto on
 *    `calls.summary`) and ADRs. All three indexes use Atlas Automated Embedding (Voyage), pre-filtered by team.
 */
import type { Document } from "mongodb";
import { config } from "./config.ts";
import type { Cols } from "./db.ts";
import type { Memory } from "./shapes.ts";

export const KNOWLEDGE_INDEX = { utterances: "utterances_auto", calls: "calls_auto", artifacts: "artifacts_auto" } as const;

type Scope = { teamId: string; projectId: string };

type AdrInputs = { related: Pick<Memory, "key" | "text">[]; checkedAgainst: string[]; alternatives: string[] };

/** ADR body for a locked decision: context (call, memory it was checked against), options considered, decision, consequences. */
export function adrDoc(mem: Memory & { _id: NonNullable<Memory["_id"]> }, call: Document | null, inputs: AdrInputs): Document {
  const { related, checkedAgainst, alternatives } = inputs;
  const date = (mem.lock?.lockedAt ?? mem.createdAt ?? new Date()).toISOString().slice(0, 10);
  const title = mem.text.split(/[.:;]/)[0].slice(0, 90);
  const context = [
    call?.title ? `Discussed in "${String(call.title)}".` : "",
    typeof call?.summary === "string" ? String(call.summary) : "",
    ...related.map((r) => `${r.key}: ${r.text}`),
    ...checkedAgainst,
  ].filter(Boolean).join("\n");
  const keys = [...new Set([...related.map((r) => r.key), ...checkedAgainst.map((l) => /^([A-Z]-\d{2,3})/.exec(l)?.[1])].filter(Boolean))];
  const text = [
    `# ADR ${mem.key ?? ""}: ${title}`,
    `Status: Accepted (${date}${mem.lock?.via ? `, by ${mem.lock.via}` : ""})`,
    mem.lock?.participants?.length ? `Deciders: ${mem.lock.participants.join(", ")}` : "",
    "", "## Context", context || "(no recorded context)",
    ...(alternatives.length ? ["", "## Options considered", ...alternatives.map((a) => `- ${a}`)] : []),
    "", "## Decision", mem.text,
    "", "## Consequences", keys.length ? `Must keep satisfying ${keys.join(", ")}.` : "Revisit if requirements change.",
  ].join("\n");
  return {
    teamId: mem.teamId, projectId: mem.projectId, kind: "adr", memoryId: mem._id, key: mem.key, title, status: "accepted",
    decidedAt: mem.lock?.lockedAt ?? mem.createdAt, deciders: mem.lock?.participants ?? [], callId: call?._id ?? null,
    alternatives, constraints: keys, text, synthetic: mem.synthetic ?? false, updatedAt: new Date(),
  };
}

/** Write (or refresh) the ADR artifact for a locked decision memory. */
export async function writeAdr(c: Cols, mem: Memory & { _id: NonNullable<Memory["_id"]> }): Promise<void> {
  if (mem.kind !== "decision") return;
  const ref = mem.sourceRefs.find((r) => r.type === "call");
  const callId = ref && ref.type === "call" ? ref.callId : null;
  const call = callId ? await c.calls.findOne({ _id: callId as never }) : null;
  const keys = [...new Set([...mem.text.matchAll(/\b[A-Z]-\d{2,3}\b/g)].map((m) => m[0]))].filter((k) => k !== mem.key);
  const [related, conflicts, alts] = await Promise.all([
    keys.length ? c.memories.find({ teamId: mem.teamId, status: "active", key: { $in: keys } }).project<Pick<Memory, "key" | "text">>({ key: 1, text: 1 }).toArray() : Promise.resolve([]),
    // Memory the discussion was checked against in this call (what Gomon flagged), and the alternatives that were raised.
    callId ? c.conflicts.find({ callId }).toArray() : Promise.resolve([]),
    callId ? c.callItems.find({ callId, kind: "alternative" }).toArray() : Promise.resolve([]),
  ]);
  const checkedAgainst = [...new Map(conflicts.filter((x) => x.memoryKey).map((x) => [x.memoryKey, `${x.memoryKey} (flagged in the call): ${x.note}`])).values()];
  const alternatives = alts.map((a) => `${a.text} (rejected)`);
  await c.artifacts.updateOne({ memoryId: mem._id }, { $set: adrDoc(mem, call, { related, checkedAgainst, alternatives }), $setOnInsert: { createdAt: new Date() } }, { upsert: true });
}

export type KnowledgeHit = { id: string; line: string };

function speakerName(v: unknown): string {
  return v && typeof v === "object" && "displayName" in v && typeof v.displayName === "string" ? v.displayName : "someone";
}

/** Semantic search across past transcripts, meeting summaries and ADRs (Voyage via Atlas Automated Embedding). */
export async function searchKnowledge(c: Cols, scope: Scope, query: string, excludeCallId: string): Promise<KnowledgeHit[]> {
  const vs = (index: string, path: string, filter: Document, limit: number) => ({
    $vectorSearch: { index, path, query, model: config.embedModel, numCandidates: 100, limit, filter },
  });
  const [lines, summaries, adrs] = await Promise.all([
    c.utterances.aggregate<Document>([
      vs(KNOWLEDGE_INDEX.utterances, "text", { teamId: scope.teamId, callId: { $ne: excludeCallId } }, 6),
      { $project: { callId: 1, text: 1, speaker: 1 } },
    ]).toArray().catch(() => []),
    c.calls.aggregate<Document>([
      vs(KNOWLEDGE_INDEX.calls, "summary", { teamId: scope.teamId }, 3),
      { $match: { _id: { $ne: excludeCallId } } },
      { $project: { title: 1, summary: 1, startedAt: 1 } },
    ]).toArray().catch(() => []),
    c.artifacts.aggregate<Document>([
      vs(KNOWLEDGE_INDEX.artifacts, "text", { teamId: scope.teamId }, 3),
      { $project: { key: 1, title: 1, decidedAt: 1 } },
    ]).toArray().catch(() => []),
  ]);
  const titles = new Map<string, string>();
  const callIds = [...new Set(lines.map((l) => String(l.callId)))];
  if (callIds.length) for (const cd of await c.calls.find({ _id: { $in: callIds as never[] } }).project({ title: 1 }).toArray()) titles.set(String(cd._id), String(cd.title ?? cd._id));
  const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : "");
  return [
    ...summaries.map((s) => ({ id: `call:${String(s._id)}`, line: `meeting "${String(s.title)}" (${day(s.startedAt)}): ${String(s.summary).slice(0, 300)}` })),
    ...lines.map((l) => ({ id: `call:${String(l.callId)}`, line: `in "${titles.get(String(l.callId)) ?? l.callId}", ${speakerName(l.speaker)} said: ${String(l.text).slice(0, 200)}` })),
  ];
}
