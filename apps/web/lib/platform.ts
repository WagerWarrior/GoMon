/**
 * Read models for the Gomon platform pages (overview, sessions, memory, activity, actions, system, database).
 * Everything reads Atlas directly (source of truth) and returns plain JSON. Env values are never returned, only whether they are set.
 */
import type { Db } from "mongodb";
import { db, dbName, scope } from "./db";
import { stageStats } from "./stats";

const plain = <T>(v: unknown): T => JSON.parse(JSON.stringify(v));
const ms = (t: unknown) => (t ? new Date(t as string).getTime() : NaN);

export interface SessionRow {
  id: string; title: string; status: string; participants: string[]; startedAt: string | null; durationMs: number | null;
  utterances: number; items: number; locked: number; says: number; actions: number; memoryEnabled: boolean;
}

async function counts(d: Db, coll: string, match: object, extra: object = {}) {
  const rows = await d.collection(coll).aggregate([{ $match: match }, { $group: { _id: "$callId", n: { $sum: 1 }, ...extra } }]).toArray();
  return new Map(rows.map((r) => [String(r._id), r]));
}

export async function sessions(limit = 200): Promise<SessionRow[]> {
  const d = await db(); const { teamId, projectId } = scope(); const tp = { teamId, projectId };
  const [calls, utt, items, says, acts] = await Promise.all([
    d.collection("calls").find(tp).sort({ startedAt: -1 }).limit(limit).toArray(),
    counts(d, "utterances", tp, { first: { $min: { $ifNull: ["$startedAt", "$receivedAt"] } }, last: { $max: { $ifNull: ["$endedAt", { $ifNull: ["$receivedAt", "$startedAt"] }] } }, speakers: { $addToSet: "$speaker.displayName" } }),
    counts(d, "call_items", tp, { locked: { $sum: { $cond: [{ $eq: ["$status", "promoted"] }, 1, 0] } } }),
    counts(d, "says", tp),
    counts(d, "actions", tp),
  ]);
  return calls.map((c) => {
    const id = String(c._id); const u = utt.get(id);
    const start = Math.min(ms(c.startedAt), ms(u?.first)) || ms(c.startedAt); const end = ms(c.endedAt ?? u?.last);
    const people = [...new Set<string>([...(c.participants ?? []), ...((u?.speakers ?? []) as string[]).filter((s) => s !== "Gomon")])];
    return {
      id, title: c.title || "Design call", status: c.status || "unknown", participants: people,
      startedAt: c.startedAt ? new Date(c.startedAt).toISOString() : null,
      durationMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
      utterances: u?.n ?? 0, items: items.get(id)?.n ?? 0, locked: items.get(id)?.locked ?? 0,
      says: says.get(id)?.n ?? 0, actions: acts.get(id)?.n ?? 0, memoryEnabled: c.memoryEnabled !== false,
    };
  });
}

export async function session(callId: string) {
  const d = await db(); const q = { callId };
  const [call, utterances, items, says, runs, timings, conflicts, actions, audit] = await Promise.all([
    d.collection("calls").findOne({ _id: callId as any }),
    d.collection("utterances").find(q).sort({ seq: 1 }).limit(2000).toArray(),
    d.collection("call_items").find(q).sort({ _id: 1 }).toArray(),
    d.collection("says").find(q).sort({ createdAt: 1 }).toArray(),
    d.collection("agent_events").find(q).sort({ at: 1 }).limit(500).toArray(),
    d.collection("timings").find(q).sort({ at: 1 }).limit(2000).toArray(),
    d.collection("conflicts").find(q).sort({ createdAt: 1 }).toArray(),
    d.collection("actions").find(q).sort({ createdAt: 1 }).toArray(),
    d.collection("audit_events").find(q).sort({ at: 1 }).toArray(),
  ]);
  const row = (await sessions()).find((s) => s.id === callId) ?? null;
  return plain<any>({ call, row, utterances, items, says, runs, timings, stages: stageStats(timings as any), conflicts, actions, audit });
}

export interface Bucket { t: string; n: number }
export async function overview() {
  const d = await db(); const { teamId, projectId } = scope(); const tp = { teamId, projectId };
  const [rows, itemStatus, memKinds, memStatus, actionStatus, timings, uttTimes, says, audit] = await Promise.all([
    sessions(),
    d.collection("call_items").aggregate([{ $match: tp }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    d.collection("memories").aggregate([{ $match: { ...tp, status: { $ne: "forgotten" } } }, { $group: { _id: "$kind", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
    d.collection("memories").aggregate([{ $match: tp }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    d.collection("actions").aggregate([{ $match: tp }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    d.collection("timings").find(tp, { projection: { stage: 1, ms: 1, at: 1 } }).sort({ at: -1 }).limit(3000).toArray(),
    d.collection("utterances").find(tp, { projection: { startedAt: 1, receivedAt: 1 } }).sort({ _id: -1 }).limit(5000).toArray(),
    d.collection("says").countDocuments(tp),
    d.collection("audit_events").countDocuments(tp),
  ]);
  const by = (a: any[]) => Object.fromEntries(a.map((r) => [String(r._id ?? "none"), r.n as number]));
  // Utterances per minute over the window that holds data (most recent 60 minutes with activity).
  const times = uttTimes.map((u) => ms(u.startedAt ?? u.receivedAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const series: Bucket[] = [];
  if (times.length) {
    const end = Math.ceil(times[times.length - 1] / 60000) * 60000; const start = Math.max(Math.floor(times[0] / 60000) * 60000, end - 60 * 60000);
    for (let t = start; t < end; t += 60000) series.push({ t: new Date(t).toISOString(), n: 0 });
    for (const t of times) { const i = Math.floor((t - start) / 60000); if (i >= 0 && i < series.length) series[i].n++; }
  }
  const latency = timings.map((t) => ({ at: new Date(t.at).toISOString(), ms: t.ms as number, stage: t.stage as string })).filter((t) => t.stage === "total").reverse().slice(-80);
  const items = by(itemStatus);
  return plain<any>({
    sessions: rows,
    kpi: {
      sessions: rows.length, live: rows.filter((r) => r.status === "live").length,
      utterances: rows.reduce((a, r) => a + r.utterances, 0),
      memories: Object.entries(by(memStatus)).filter(([k]) => k !== "forgotten").reduce((a, [, n]) => a + n, 0),
      locked: items.promoted ?? 0, says, audit,
      p50: stageStats(timings as any).find((s) => s.stage === "total")?.p50 ?? null,
    },
    funnel: [
      { label: "Heard", n: Object.values(items).reduce((a, n) => a + n, 0) },
      { label: "Proposed to lock", n: (items.locking ?? 0) + (items.promoted ?? 0) + (items.rejected ?? 0) },
      { label: "Locked", n: items.promoted ?? 0 },
    ],
    vetoed: items.rejected ?? 0,
    memKinds: memKinds.map((m) => ({ label: String(m._id), n: m.n })),
    actions: by(actionStatus),
    stages: stageStats(timings as any).sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0)),
    series, latency,
  });
}

export interface ActivityRow { at: string; kind: string; actor: string; text: string; callId?: string; tone?: "good" | "bad" | "warn" }
export async function activity(limit = 300, callId?: string): Promise<ActivityRow[]> {
  const d = await db(); const { teamId, projectId } = scope(); const q: any = callId ? { callId } : { teamId, projectId };
  const [audit, says, acts, runs, conflicts] = await Promise.all([
    d.collection("audit_events").find(q).sort({ at: -1 }).limit(limit).toArray(),
    d.collection("says").find(q).sort({ createdAt: -1 }).limit(limit).toArray(),
    d.collection("actions").find(q).sort({ createdAt: -1 }).limit(limit).toArray(),
    d.collection("agent_events").find(q).sort({ at: -1 }).limit(limit).toArray(),
    d.collection("conflicts").find(q).sort({ createdAt: -1 }).limit(limit).toArray(),
  ]);
  const tone = (t: string): ActivityRow["tone"] => (/lock|promot|sent|confirm/.test(t) ? "good" : /reject|denied|fail|forgot|veto/.test(t) ? "bad" : undefined);
  const out: ActivityRow[] = [
    ...audit.map((a) => ({ at: a.at, kind: String(a.type).replace(/_/g, " "), actor: a.actor ?? "system", text: a.reason ?? a.summary ?? "", callId: a.callId, tone: tone(a.type) })),
    ...says.map((s) => ({ at: s.createdAt, kind: `said · ${s.status ?? "queued"}`, actor: "Gomon", text: s.text, callId: s.callId })),
    ...acts.map((a) => ({ at: a.updatedAt ?? a.createdAt, kind: `${String(a.type).replace(/_/g, " ")} · ${a.status}`, actor: "outbox", text: a.payload?.title ?? a.payload?.text ?? "", callId: a.callId, tone: tone(a.status) })),
    ...runs.map((r) => ({ at: r.at, kind: r.wake ? "agent run · wake" : "agent run", actor: "worker", text: `${r.batchSize ?? 1} utterance${(r.batchSize ?? 1) === 1 ? "" : "s"}, ${(r.retrievedMemoryIds ?? []).length} memories recalled${r.memoryEnabled === false ? " (memory off)" : ""}`, callId: r.callId })),
    ...conflicts.map((c) => ({ at: c.createdAt, kind: c.kind === "already_decided" ? "already decided" : "conflict", actor: "Gomon", text: `${c.memoryKey ? c.memoryKey + ": " : ""}${c.note ?? ""}`, callId: c.callId, tone: "warn" as const })),
  ].map((r) => ({ ...r, at: new Date(r.at as any).toISOString() }));
  return plain<ActivityRow[]>(out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit));
}

export async function memories() {
  const d = await db(); const { teamId, projectId } = scope();
  return plain<any[]>(await d.collection("memories").find({ teamId, projectId }, { projection: { embedding: 0 } }).sort({ createdAt: -1 }).limit(500).toArray());
}

export async function actions() {
  const d = await db(); const { teamId, projectId } = scope();
  return plain<any[]>(await d.collection("actions").find({ teamId, projectId }).sort({ createdAt: -1 }).limit(300).toArray());
}

const set = (k: string) => !!process.env[k];
export function system() {
  return {
    models: [
      { role: "Reasoning", name: process.env.ANALYZE_MODEL || "claude-haiku-5-5", provider: process.env.LLM_PROVIDER || "Anthropic", ready: set("LLM_API_KEY"), note: "Extracts decisions, checks conflicts, writes what Gomon says." },
      { role: "Embeddings", name: process.env.VOYAGE_MODEL || process.env.EMBED_MODEL || "voyage-4", provider: "Voyage AI via Atlas", ready: set("VOYAGE_API_KEY") || true, note: "Atlas automated embedding on memories (vector index memories_auto)." },
      { role: "Voice", name: process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5", provider: "ElevenLabs", ready: set("ELEVENLABS_API_KEY"), note: process.env.ELEVENLABS_VOICE_ID ? "Custom voice selected." : "Default voice." },
      { role: "Transcription", name: `Recall.ai ${process.env.RECALL_BOT_VARIANT || "web_4_core"}`, provider: `Recall ${process.env.RECALL_REGION || "us-west-2"}`, ready: set("RECALL_API_KEY"), note: "Meeting bot joins the call and streams sentences." },
    ],
    connectors: [
      { name: "MongoDB Atlas", detail: `database ${dbName()}`, ready: set("MONGODB_URI") },
      { name: "Slack", detail: process.env.SLACK_CHANNEL_ID ? "channel set" : "no channel", ready: set("SLACK_BOT_TOKEN") },
      { name: "GitHub issues", detail: process.env.GITHUB_REPO || "no repo", ready: set("GITHUB_TOKEN") || set("GH_TOKEN") },
    ],
    rules: [
      { name: "Veto window", value: `${Number(process.env.VETO_MS || 10000) / 1000} s` },
      { name: "Wake word", value: process.env.AGENT_NAME || "Gomon" },
      { name: "Scratch items expire", value: `${Number(process.env.SCRATCH_TTL_MS || 6 * 3600000) / 3600000} h` },
      { name: "Suggestion limit", value: `1 per ${Number(process.env.SUGGESTION_WINDOW_MS || 300000) / 60000} min` },
    ],
    scope: scope(),
  };
}

export async function database() {
  const d = await db();
  const cols = (await d.listCollections().toArray()).map((c) => c.name).filter((n) => !n.startsWith("system.")).sort();
  const rows = await Promise.all(cols.map(async (name) => {
    const c = d.collection(name);
    const [count, sample, indexes] = await Promise.all([c.estimatedDocumentCount(), c.findOne({}, { sort: { _id: -1 }, projection: { embedding: 0, token: 0 } }), c.indexes().catch(() => [])]);
    let search: string[] = [];
    try { search = (await c.listSearchIndexes().toArray()).map((i: any) => `${i.name} (${i.type ?? "search"})`); } catch {}
    return { name, count, fields: sample ? Object.keys(sample) : [], sample: sample ? JSON.stringify(sample, null, 2).slice(0, 1600) : "", indexes: indexes.map((i: any) => i.name), search };
  }));
  return { db: dbName(), rows };
}
