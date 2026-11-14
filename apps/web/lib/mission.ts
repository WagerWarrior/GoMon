/**
 * Mission control read model and operator commands.
 * Every op is derived from a real Atlas write (utterances, timings, call_items, conflicts, audit_events, says, actions),
 * labelled with a verb and the edge it travels on the system canvas. Operator commands go through Atlas too:
 * a prompt is a typed utterance (the worker's change stream wakes the agent), a say is a queued `says` doc (the bot speaks it).
 */
import { ObjectId, type Db } from "mongodb";
import { randomUUID } from "node:crypto";
import { cached, db, scope } from "./db";

export type Verb = "LISTEN" | "WAKE" | "SEARCH" | "THINK" | "APPEND" | "FLAG" | "LOCK" | "VETO" | "SPEAK" | "SEND" | "OPERATOR";
export interface Op { id: string; at: string; verb: Verb; node: NodeId; edges: EdgeId[]; coll: string; rw: "read" | "write"; text: string; who?: string; ms?: number }
export type NodeId = "call" | "operator" | "utt" | "worker" | "mem" | "items" | "gov" | "says" | "outbox";
export type EdgeId = "call-utt" | "op-utt" | "op-says" | "utt-worker" | "worker-mem" | "worker-items" | "worker-says" | "items-gov" | "gov-mem" | "gov-outbox" | "says-call";

const iso = (t: unknown, id?: unknown) => {
  const v = t ? new Date(t as string) : id instanceof ObjectId ? id.getTimestamp() : null;
  return v && !isNaN(+v) ? v.toISOString() : null;
};
const cut = (s: unknown, n = 140) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

export async function focusCall(d: Db, want?: string) {
  const { teamId, projectId } = scope();
  if (want) return want;
  const u = await d.collection("utterances").find({ teamId, projectId }).sort({ _id: -1 }).limit(1).next();
  if (u) return String(u.callId);
  const c = await d.collection("calls").find({ teamId, projectId }).sort({ startedAt: -1 }).limit(1).next();
  return c ? String(c._id) : null;
}

export function mission(want?: string) { return cached(`mission:${want ?? ""}`, 1000, () => loadMission(want), 5000); }
async function loadMission(want?: string) {
  const d = await db(); const { teamId, projectId } = scope();
  const callId = await focusCall(d, want);
  const calls = await d.collection("calls").find({ teamId, projectId }).sort({ startedAt: -1 }).limit(12).project({ title: 1, status: 1, startedAt: 1, participants: 1, memoryEnabled: 1 }).toArray();
  if (!callId) return { now: new Date().toISOString(), callId: null, calls: JSON.parse(JSON.stringify(calls)), ops: [], context: null };
  const q = { callId };
  const [call, utt, timings, items, conflicts, audit, says, acts, runs] = await Promise.all([
    d.collection("calls").findOne({ _id: callId as any }),
    d.collection("utterances").find(q).sort({ _id: -1 }).limit(60).toArray(),
    d.collection("timings").find({ ...q, stage: { $in: ["queue", "retrieve", "analyze", "wake_to_chime", "fast_reply"] } }).sort({ _id: -1 }).limit(90).toArray(),
    d.collection("call_items").find(q).sort({ _id: -1 }).limit(40).toArray(),
    d.collection("conflicts").find(q).sort({ _id: -1 }).limit(20).toArray(),
    d.collection("audit_events").find(q).sort({ at: -1 }).limit(40).toArray(),
    d.collection("says").find(q).sort({ _id: -1 }).limit(30).toArray(),
    d.collection("actions").find(q).sort({ _id: -1 }).limit(20).toArray(),
    d.collection("agent_events").find(q).sort({ at: -1 }).limit(20).toArray(),
  ]);
  const ops: Op[] = [];
  const push = (o: Omit<Op, "at"> & { at: string | null }) => { if (o.at) ops.push(o as Op); };
  for (const u of utt) {
    const operator = u.speaker?.displayName === "Mission control";
    push({ id: `u${u._id}`, at: iso(u.receivedAt ?? u.startedAt, u._id), verb: operator ? "OPERATOR" : "LISTEN", node: "utt", edges: [operator ? "op-utt" : "call-utt"], coll: "utterances", rw: "write", who: u.speaker?.displayName, text: cut(u.text) });
  }
  for (const t of timings) {
    const at = iso(t.at, t._id);
    if (t.stage === "queue") push({ id: `t${t._id}`, at, verb: "WAKE", node: "worker", edges: ["utt-worker"], coll: "utterances", rw: "read", text: "worker claimed the batch", ms: t.ms });
    if (t.stage === "retrieve") push({ id: `t${t._id}`, at, verb: "SEARCH", node: "mem", edges: ["worker-mem"], coll: "memories", rw: "read", text: "vector + text search over team memory", ms: t.ms });
    // Floor signals (worker floor.ts / voice.ts): the chime the moment Gomon hears its name, and the fast answer lane.
    if (t.stage === "wake_to_chime") push({ id: `t${t._id}`, at, verb: "WAKE", node: "worker", edges: ["utt-worker"], coll: "utterances", rw: "read", text: "heard its name, chime played in the meeting", ms: t.ms });
    if (t.stage === "fast_reply") push({ id: `t${t._id}`, at, verb: "THINK", node: "worker", edges: ["worker-mem"], coll: "llm", rw: "read", text: "answered from memory on the fast lane", ms: t.ms });
    if (t.stage === "analyze") push({ id: `t${t._id}`, at, verb: "THINK", node: "worker", edges: [], coll: "llm", rw: "read", text: "reasoning model read the turn and memory", ms: t.ms });
  }
  for (const e of runs) {
    if (e.kind === "barge_in") push({ id: `e${e._id}`, at: iso(e.at, e._id), verb: "SPEAK", node: "says", edges: ["says-call"], coll: "says", rw: "write", who: "Gomon", text: `stopped talking (${e.why === "stop_word" ? "someone said stop" : e.why === "wake_word" ? "new question" : "someone talked over it"})` });
    if (e.kind === "alias_learned") push({ id: `e${e._id}`, at: iso(e.at, e._id), verb: "APPEND", node: "mem", edges: ["worker-mem"], coll: "members", rw: "write", text: `learned a name: "${cut(e.heard, 40)}" is ${e.person}` });
  }
  for (const i of items) push({ id: `i${i._id}`, at: iso(i.createdAt, i._id), verb: "APPEND", node: "items", edges: ["worker-items"], coll: "call_items", rw: "write", text: `${String(i.kind).replace(/_/g, " ")}: ${cut(i.text, 110)}` });
  for (const c of conflicts) push({ id: `c${c._id}`, at: iso(c.createdAt, c._id), verb: "FLAG", node: "worker", edges: ["worker-mem"], coll: "conflicts", rw: "write", text: `${c.memoryKey ? c.memoryKey + " · " : ""}${cut(c.note, 120)}` });
  for (const a of audit) {
    const t = String(a.type);
    if (/lock|promot/.test(t)) push({ id: `a${a._id}`, at: iso(a.at, a._id), verb: "LOCK", node: "gov", edges: ["items-gov", "gov-mem"], coll: "memories", rw: "write", who: a.actor, text: cut(a.reason ?? t) });
    else if (/reject|veto/.test(t)) push({ id: `a${a._id}`, at: iso(a.at, a._id), verb: "VETO", node: "gov", edges: ["items-gov"], coll: "call_items", rw: "write", who: a.actor, text: cut(a.reason ?? t) });
    else if (/^operator/.test(t)) continue;
    else push({ id: `a${a._id}`, at: iso(a.at, a._id), verb: "LOCK", node: "gov", edges: [], coll: "audit_events", rw: "write", who: a.actor, text: `${t.replace(/_/g, " ")}${a.reason ? " · " + cut(a.reason, 90) : ""}` });
  }
  for (const s of says) {
    const operator = s.reason === "operator";
    push({ id: `s${s._id}`, at: iso(s.createdAt, s._id), verb: operator ? "OPERATOR" : "SPEAK", node: "says", edges: operator ? ["op-says", "says-call"] : ["worker-says", "says-call"], coll: "says", rw: "write", who: "Gomon", text: `${cut(s.text)} (${s.status})` });
  }
  for (const a of acts) push({ id: `x${a._id}`, at: iso(a.sentAt ?? a.createdAt, a._id), verb: "SEND", node: "outbox", edges: ["gov-outbox"], coll: "actions", rw: "write", text: `${String(a.type).replace(/_/g, " ")} · ${a.status}${a.externalId ? " · " + a.externalId : ""}` });
  ops.sort((a, b) => b.at.localeCompare(a.at));

  // Context: what Gomon holds right now for this call.
  const lastRun = runs[0];
  const recalledIds = (lastRun?.retrievedMemoryIds ?? []).slice(0, 8).map((x: any) => { try { return new ObjectId(String(x)); } catch { return null; } }).filter(Boolean);
  const recalled = recalledIds.length ? await d.collection("memories").find({ _id: { $in: recalledIds as ObjectId[] } }, { projection: { embedding: 0 } }).toArray() : [];
  const context = {
    title: call?.title ?? "Design call", status: call?.status ?? "unknown", memoryEnabled: call?.memoryEnabled !== false,
    participants: [...new Set<string>([...(call?.participants ?? []), ...utt.map((u) => u.speaker?.displayName).filter((n) => n && n !== "Gomon" && n !== "Mission control")])],
    startedAt: iso(call?.startedAt, null) ?? iso(null, utt[utt.length - 1]?._id),
    heard: utt.slice(0, 6).reverse().map((u) => ({ who: u.speaker?.displayName ?? "?", text: cut(u.text, 200), at: iso(u.receivedAt, u._id) })),
    recalled: recalled.map((m) => ({ id: String(m._id), key: m.key ?? null, kind: m.kind, text: cut(m.text, 180), status: m.status })),
    open: items.filter((i) => i.status === "proposed" || i.status === "locking").slice(0, 6).map((i) => ({ kind: i.kind, text: cut(i.text, 160), status: i.status, lockAnnouncedAt: iso(i.lockAnnouncedAt, null), vetoMs: i.vetoMs ?? 10000 })),
    lastRun: lastRun ? { at: iso(lastRun.at, lastRun._id), wake: Array.isArray(lastRun.wake) ? lastRun.wake.length > 0 : !!lastRun.wake, model: lastRun.model ?? null, batch: lastRun.batchSize ?? 1, recalled: (lastRun.retrievedMemoryIds ?? []).length } : null,
    lastSay: says[0] ? { text: says[0].text, status: says[0].status, at: iso(says[0].createdAt, says[0]._id) } : null,
  };
  return JSON.parse(JSON.stringify({ now: new Date().toISOString(), callId, calls, ops: ops.slice(0, 80), context }));
}

export async function command(input: { callId?: string; mode?: string; text?: string }) {
  const text = String(input.text ?? "").trim().slice(0, input.mode === "say" ? 600 : 2000); // spoken lines stay short; prompts may carry attached context
  const callId = String(input.callId ?? "").trim();
  if (!text || !callId) return { status: 400, data: { error: "callId and text are required" } };
  const d = await db(); const { teamId, projectId } = scope(); const now = new Date();
  if (input.mode === "say") {
    const sayId = randomUUID();
    await d.collection("says").insertOne({ sayId, callId, teamId, projectId, text, priority: "high", reason: "operator", status: "queued", createdAt: now, updatedAt: now });
    await d.collection("audit_events").insertOne({ teamId, projectId, callId, at: now, type: "operator_say", actor: "Mission control", reason: text });
    return { status: 201, data: { ok: true, sayId } };
  }
  // Prompt: a typed utterance addressed to Gomon. The worker's change stream picks it up like any other turn.
  const call = await d.collection("calls").findOneAndUpdate({ _id: callId as any }, { $inc: { utteranceSeq: 1 } }, { returnDocument: "after" });
  if (!call) return { status: 404, data: { error: "unknown call" } };
  const body = /\bgo\s?mon\b/i.test(text) ? text : `Gomon, ${text}`;
  const r = await d.collection("utterances").insertOne({ callId, teamId, projectId, seq: Number(call.utteranceSeq ?? 0), sourceKey: randomUUID(), speaker: { displayName: "Mission control" }, text: body, source: "typed", receivedAt: now });
  await d.collection("audit_events").insertOne({ teamId, projectId, callId, at: now, type: "operator_prompt", actor: "Mission control", reason: body });
  return { status: 201, data: { ok: true, utteranceId: String(r.insertedId) } };
}
