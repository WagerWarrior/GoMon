/**
 * Read models for the Gomon platform pages (overview, sessions, memory, activity, actions, system, database).
 * Everything reads Atlas directly (source of truth) and returns plain JSON. Env values are never returned, only whether they are set.
 */
import type { Db } from "mongodb";
import { cached, db, dbName, scope } from "./db";
import { projectNames } from "./projects";
import { actionKind, describeAction } from "./actions";
import { stageStats } from "./stats";

const plain = <T>(v: unknown): T => JSON.parse(JSON.stringify(v));
const ms = (t: unknown) => (t ? new Date(t as string).getTime() : NaN);

export interface SessionRow {
  id: string; title: string; status: string; participants: string[]; startedAt: string | null; durationMs: number | null;
  utterances: number; items: number; locked: number; says: number; actions: number; memoryEnabled: boolean;
  lastAt: string | null; state: "live" | "ended" | "failed"; voice: boolean; team: string[]; guests: string[];
  category: string; templateId: string; failedActions: number; unprocessed: number;
  /** The call's project (calls.projectId) and its display name. */
  projectId: string; project: string;
}

/** A session is live while anything happened in the last 5 minutes, unless it was ended explicitly (bot removed). */
export const LIVE_MS = 5 * 60_000;
const TEMPLATE_CATEGORY: Record<string, string> = { "design-review": "Design review", "silent-scribe": "Notes only", "architecture-challenger": "Architecture" };
export function categorize(c: { _id?: unknown; title?: string; category?: string; templateId?: string }) {
  if (c.category) return c.category;
  const t = `${c.title ?? ""}`.toLowerCase(); const id = String(c._id ?? "").toLowerCase();
  if (/customer|client|acme|sales|demo/.test(t)) return "Customer call";
  if (/standup|sync|retro|planning/.test(t)) return "Team sync";
  if (/rehears|smoke|test|sim|^ab-|^tpl-|^gov-|workflow-test/.test(id) || /rehears|test/.test(t)) return "Test run";
  return TEMPLATE_CATEGORY[c.templateId ?? ""] ?? "Design review";
}

async function counts(d: Db, coll: string, match: object, extra: object = {}) {
  const rows = await d.collection(coll).aggregate([{ $match: match }, { $group: { _id: "$callId", n: { $sum: 1 }, ...extra } }]).toArray();
  return new Map(rows.map((r) => [String(r._id), r]));
}

export function sessions(limit = 200): Promise<SessionRow[]> { return cached(`sessions:${limit}`, 2000, () => loadSessions(limit)); }
async function loadSessions(limit: number): Promise<SessionRow[]> {
  // All of the team's projects: a call belongs to one project, and the workspace shows every one of them.
  const d = await db(); const { teamId, projectId: defaultProject } = scope(); const tp = { teamId };
  const [calls, utt, items, says, acts, members] = await Promise.all([
    d.collection("calls").find(tp).sort({ startedAt: -1 }).limit(limit).toArray(),
    counts(d, "utterances", tp, { first: { $min: { $ifNull: ["$startedAt", "$receivedAt"] } }, last: { $max: { $ifNull: ["$endedAt", { $ifNull: ["$receivedAt", "$startedAt"] }] } }, speakers: { $addToSet: "$speaker.displayName" }, recall: { $sum: { $cond: [{ $eq: ["$source", "recall"] }, 1, 0] } }, unprocessed: { $sum: { $cond: [{ $ifNull: ["$processedAt", false] }, 0, 1] } } }),
    counts(d, "call_items", tp, { locked: { $sum: { $cond: [{ $eq: ["$status", "promoted"] }, 1, 0] } } }),
    counts(d, "says", tp, { last: { $max: "$createdAt" } }),
    counts(d, "actions", tp, { failed: { $sum: { $cond: [{ $in: ["$status", ["failed", "denied"]] }, 1, 0] } } }),
    d.collection("members").find({ teamId }).project({ displayName: 1 }).toArray(),
  ]);
  const names = await projectNames();
  const team = new Set(members.map((m) => String(m.displayName).toLowerCase()));
  const now = Date.now();
  return calls.map((c) => {
    const id = String(c._id); const u = utt.get(id);
    const start = Math.min(ms(c.startedAt), ms(u?.first)) || ms(c.startedAt); const end = ms(c.endedAt ?? u?.last);
    const people = [...new Set<string>([...(c.participants ?? []), ...((u?.speakers ?? []) as string[]).filter((s) => s !== "Gomon")])].filter((p) => p !== "Mission control");
    const lastAt = Math.max(ms(u?.last) || 0, ms(says.get(id)?.last) || 0, ms(c.startedAt) || 0);
    const failedActions = acts.get(id)?.failed ?? 0;
    const ended = c.status === "ended" || c.status === "failed";
    const state: SessionRow["state"] = !ended && now - lastAt < LIVE_MS ? "live" : c.status === "failed" || failedActions > 0 || ((u?.n ?? 0) === 0 && !ended) ? "failed" : "ended";
    const pid = typeof c.projectId === "string" ? c.projectId : defaultProject;
    return {
      lastAt: lastAt ? new Date(lastAt).toISOString() : null, state, voice: (u?.recall ?? 0) > 0,
      team: people.filter((p) => team.has(p.toLowerCase())), guests: people.filter((p) => !team.has(p.toLowerCase())),
      category: categorize(c as any), templateId: c.templateId ?? "design-review", failedActions, unprocessed: u?.unprocessed ?? 0,
      id, title: c.title || "Design call", status: c.status || "unknown", participants: people, projectId: pid, project: names.get(pid) ?? pid,
      startedAt: c.startedAt ? new Date(c.startedAt).toISOString() : null,
      durationMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
      utterances: u?.n ?? 0, items: items.get(id)?.n ?? 0, locked: items.get(id)?.locked ?? 0,
      says: says.get(id)?.n ?? 0, actions: acts.get(id)?.n ?? 0, memoryEnabled: c.memoryEnabled !== false,
    };
  });
}

export function session(callId: string) { return cached(`session:${callId}`, 1500, () => loadSession(callId), 15_000); }
async function loadSession(callId: string) {
  const d = await db(); const q = { callId };
  const [call, utterances, items, says, runs, timings, conflicts, actions, audit, docs] = await Promise.all([
    d.collection("calls").findOne({ _id: callId as any }),
    d.collection("utterances").find(q).sort({ seq: 1 }).limit(2000).toArray(),
    d.collection("call_items").find(q).sort({ _id: 1 }).toArray(),
    d.collection("says").find(q).sort({ createdAt: 1 }).toArray(),
    d.collection("agent_events").find(q).sort({ at: 1 }).limit(500).toArray(),
    d.collection("timings").find(q).sort({ at: 1 }).limit(2000).toArray(),
    d.collection("conflicts").find(q).sort({ createdAt: 1 }).toArray(),
    d.collection("actions").find(q).sort({ createdAt: 1 }).toArray(),
    d.collection("audit_events").find(q).sort({ at: 1 }).toArray(),
    d.collection("memories").aggregate([{ $match: { "sourceRefs.callId": callId } }, { $unwind: "$sourceRefs" }, { $match: { "sourceRefs.type": "doc" } }, { $group: { _id: "$sourceRefs.path" } }]).toArray(),
  ]);
  // Session facts from this call's own rows only (no full-table aggregations: keeps the page fast).
  const tAt = (u: any) => ms(u.startedAt ?? u.receivedAt);
  const first = utterances.length ? tAt(utterances[0]) : NaN; const last = utterances.length ? ms(utterances[utterances.length - 1].endedAt ?? utterances[utterances.length - 1].receivedAt ?? utterances[utterances.length - 1].startedAt) : NaN;
  const start = Math.min(ms(call?.startedAt), first) || ms(call?.startedAt); const end = ms(call?.endedAt) || last;
  const participants = [...new Set<string>([...(call?.participants ?? []), ...utterances.map((u) => u.speaker?.displayName).filter((n) => n && n !== "Gomon" && n !== "Mission control")])];
  const row = { participants, durationMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null };
  // Links this conversation produced or used: tickets, Slack thread, meeting, source docs.
  const channel = process.env.SLACK_CHANNEL_ID;
  const slackUrl = (id?: string) => { const [ch, ts] = String(id ?? "").split(":"); return ch && ts ? `https://slack.com/archives/${ch}/p${ts.replace(".", "")}` : null; };
  const memIds = [...new Set(items.map((i: any) => i.memoryId).filter(Boolean).map(String))];
  const links = [
    ...(call?.meetingUrl ? [{ kind: "Meeting", label: "Join link", url: call.meetingUrl }] : []),
    ...(call?.slackThreadTs && channel ? [{ kind: "Slack", label: "Call thread", url: `https://slack.com/archives/${channel}/p${String(call.slackThreadTs).replace(".", "")}` }] : []),
    ...actions.filter((a) => a.externalId).map((a) => ({ kind: a.type === "post_slack" ? "Slack" : "GitHub", label: a.type === "github" ? describeAction(a) : a.payload?.title ?? a.externalId, url: a.externalUrl ?? (a.type === "post_slack" ? slackUrl(a.externalId) : null), status: a.status })),
    ...docs.map((x) => ({ kind: "Doc", label: String(x._id), url: null })),
  ];
  return plain<any>({ call, row, utterances, items, says, runs, timings, stages: stageStats(timings as any), conflicts, actions, audit, links, memIds });
}

export interface Bucket { t: string; n: number }
export function overview() { return cached("overview", 2000, loadOverview); }
async function loadOverview() {
  const d = await db(); const { teamId } = scope(); const tp = { teamId };
  const [rows, itemStatus, memKinds, memStatus, actionStatus, timings, uttTimes, says, audit] = await Promise.all([
    sessions(),
    d.collection("call_items").aggregate([{ $match: tp }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    d.collection("memories").aggregate([{ $match: { ...tp, status: { $ne: "forgotten" } } }, { $group: { _id: "$kind", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
    d.collection("memories").aggregate([{ $match: tp }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    d.collection("actions").aggregate([{ $match: tp }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    d.collection("timings").find(tp, { projection: { stage: 1, ms: 1, at: 1 } }).sort({ _id: -1 }).limit(3000).toArray(),
    d.collection("utterances").find(tp, { projection: { startedAt: 1, receivedAt: 1, processedAt: 1 } }).sort({ _id: -1 }).limit(5000).toArray(),
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
  // Reliability: what a buyer would ask. All from real rows; no targets are invented beyond the latency SLOs below.
  const acted = Object.entries(by(actionStatus)); const actTotal = acted.reduce((a, [, n]) => a + n, 0);
  const actOk = acted.filter(([k]) => k === "confirmed" || k === "sent").reduce((a, [, n]) => a + n, 0);
  const lag = uttTimes.filter((u) => u.processedAt && u.receivedAt).map((u) => ms(u.processedAt) - ms(u.receivedAt));
  const uttTotal = rows.reduce((a, r) => a + r.utterances, 0); const uttDone = uttTotal - rows.reduce((a, r) => a + r.unprocessed, 0);
  const totalStage = stageStats(timings as any).find((s) => s.stage === "total");
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const reliability = {
    failed: rows.filter((r) => r.state === "failed").length,
    failedRate: pct(rows.filter((r) => r.state === "failed").length, rows.length),
    botJoined: rows.filter((r) => r.voice).length, botJoinRate: pct(rows.filter((r) => r.voice).length, rows.length),
    pipeline: pct(uttDone, uttTotal), within10s: pct(lag.filter((x) => x < 10_000).length, lag.length),
    sends: pct(actOk, actTotal), sendsOk: actOk, sendsTotal: actTotal,
    benchmarks: [
      { name: "Utterance → answer p50", value: totalStage?.p50 ?? null, target: 2500 },
      { name: "Utterance → answer p95", value: totalStage?.p95 ?? null, target: 6000 },
      { name: "Memory search p50", value: stageStats(timings as any).find((s) => s.stage === "retrieve")?.p50 ?? null, target: 500 },
      { name: "Reasoning p50", value: stageStats(timings as any).find((s) => s.stage === "analyze")?.p50 ?? null, target: 2500 },
    ],
  };
  return plain<any>({
    reliability,
    sessions: rows,
    kpi: {
      sessions: rows.length, live: rows.filter((r) => r.state === "live").length,
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
export function activity(limit = 300, callId?: string): Promise<ActivityRow[]> { return cached(`activity:${limit}:${callId ?? ""}`, 2000, () => loadActivity(limit, callId)); }
async function loadActivity(limit: number, callId?: string): Promise<ActivityRow[]> {
  const d = await db(); const { teamId } = scope(); const q: any = callId ? { callId } : { teamId };
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
    ...acts.map((a) => ({ at: a.updatedAt ?? a.createdAt, kind: `${actionKind(a)} · ${a.status}`, actor: "outbox", text: describeAction(a), callId: a.callId, tone: tone(a.status) })),
    ...runs.map((r) => ({ at: r.at, kind: r.wake ? "agent run · wake" : "agent run", actor: "worker", text: `${r.batchSize ?? 1} utterance${(r.batchSize ?? 1) === 1 ? "" : "s"}, ${(r.retrievedMemoryIds ?? []).length} memories recalled${r.memoryEnabled === false ? " (memory off)" : ""}`, callId: r.callId })),
    ...conflicts.map((c) => ({ at: c.createdAt, kind: c.kind === "already_decided" ? "already decided" : "conflict", actor: "Gomon", text: `${c.memoryKey ? c.memoryKey + ": " : ""}${c.note ?? ""}`, callId: c.callId, tone: "warn" as const })),
  ].map((r) => ({ ...r, at: new Date(r.at as any).toISOString() }));
  return plain<ActivityRow[]>(out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit));
}

/** Every memory of the team: company context and each project's own, labeled with the project's name. */
export async function memories() {
  const d = await db(); const { teamId } = scope();
  const [rows, names] = await Promise.all([d.collection("memories").find({ teamId }, { projection: { embedding: 0 } }).sort({ createdAt: -1 }).limit(500).toArray(), projectNames()]);
  return plain<any[]>(rows.map((m) => ({ ...m, projectName: names.get(m.projectId) ?? m.projectId })));
}

export async function actions() {
  const d = await db(); const { teamId } = scope();
  return plain<any[]>(await d.collection("actions").find({ teamId }).sort({ createdAt: -1 }).limit(300).toArray());
}

const set = (k: string) => !!process.env[k];
export function system() {
  return {
    models: [
      { role: "Reasoning", name: process.env.ANALYZE_MODEL || "claude-sonnet-5-5", provider: process.env.LLM_PROVIDER || "Anthropic", ready: set("LLM_API_KEY"), note: "Extracts decisions, checks conflicts, writes what Gomon says." },
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

export function database() { return cached("database", 15000, loadDatabase); }
async function loadDatabase() {
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

/** One collection, inspected: inferred schema over the latest 200 docs, indexes, latest rows. */
export function collection(name: string) {
  return cached(`coll:${name}`, 5000, async () => {
    const d = await db(); const c = d.collection(name);
    const [count, docs, indexes] = await Promise.all([c.estimatedDocumentCount(), c.find({}, { projection: { embedding: 0, token: 0 } }).sort({ _id: -1 }).limit(200).toArray(), c.indexes().catch(() => [])]);
    let search: string[] = [];
    try { search = (await c.listSearchIndexes().toArray()).map((i: any) => `${i.name} (${i.type ?? "search"})`); } catch {}
    const fields = new Map<string, { n: number; types: Set<string> }>();
    const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : v instanceof Date ? "date" : typeof v === "object" && (v as any)._bsontype === "ObjectId" ? "objectId" : typeof v);
    for (const doc of docs) for (const [k, v] of Object.entries(doc)) { const f = fields.get(k) ?? fields.set(k, { n: 0, types: new Set() }).get(k)!; f.n++; f.types.add(typeOf(v)); }
    return plain<any>({
      name, count, indexes: indexes.map((i: any) => ({ name: i.name, key: i.key, unique: !!i.unique, ttl: i.expireAfterSeconds ?? null })), search,
      fields: [...fields.entries()].map(([k, f]) => ({ name: k, presence: Math.round((f.n / Math.max(1, docs.length)) * 100), types: [...f.types] })),
      docs: docs.slice(0, 25),
    });
  });
}

/** One document by _id (ObjectId or string) or, for memories, by key. Used by links like /database/memories?id=... */
export async function findDoc(name: string, id?: string, key?: string) {
  if (!id && !key) return null;
  const d = await db(); const c = d.collection(name);
  const { ObjectId } = await import("mongodb");
  const q: any = key ? { key } : ObjectId.isValid(id!) && id!.length === 24 ? { _id: new ObjectId(id!) } : { _id: id };
  const doc = await c.find(q, { projection: { embedding: 0, token: 0 } }).sort({ version: -1, _id: -1 }).limit(1).next();
  return doc ? plain<any>(doc) : null;
}

/** Setup checklist for Models & voice: which env keys each service needs and whether each is set (never the value). */
export function setup() {
  const has = (k: string) => !!process.env[k];
  const svc = (name: string, role: string, does: string, keys: string[], value: string) => ({ name, role, does, value, keys: keys.map((k) => ({ k, set: has(k) })), ready: keys.filter((k) => !/MODEL|REGION|VARIANT|VOICE_ID|PROJECT|FORMAT/.test(k)).every(has) });
  return [
    svc("MongoDB Atlas", "Memory and data", "Stores every call, memory and action. Vector search finds relevant memory.", ["MONGODB_URI", "MONGODB_DB"], process.env.MONGODB_DB || "gomon"),
    svc("Reasoning model", "Thinks", "Reads each turn with recalled memory and decides what to capture or say.", ["LLM_API_KEY", "ANALYZE_MODEL"], process.env.ANALYZE_MODEL || "claude-sonnet-5-5"),
    svc("Embeddings", "Searches", "Turns memory into vectors for search inside Atlas.", ["VOYAGE_API_KEY", "VOYAGE_MODEL"], process.env.VOYAGE_MODEL || "voyage-4"),
    svc("Meeting bot", "Hears", "Joins Google Meet, Zoom or Teams through Recall.ai and streams what people say.", ["RECALL_API_KEY", "RECALL_REGION", "RECALL_BOT_VARIANT"], `Recall.ai ${process.env.RECALL_REGION || "us-west-2"}`),
    svc("Voice", "Speaks", "Turns Gomon's lines into speech in the call.", ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "ELEVENLABS_MODEL_ID"], process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5"),
    svc("Slack", "Sends", "Posts locked decisions into the call's thread.", ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"], process.env.SLACK_CHANNEL_ID ? "channel set" : "no channel"),
    svc("GitHub", "Sends", "Opens an issue for each locked decision.", ["GITHUB_TOKEN", "GITHUB_REPO"], process.env.GITHUB_REPO || "no repo"),
    svc("Tracing", "Observes", "Sends agent traces to LangSmith.", ["LANGSMITH_API_KEY", "LANGSMITH_PROJECT"], process.env.LANGSMITH_PROJECT || "default"),
  ];
}
export async function atlasPing() {
  const t = Date.now();
  try { await (await db()).command({ ping: 1 }); return { ok: true, ms: Date.now() - t }; } catch { return { ok: false, ms: Date.now() - t }; }
}
