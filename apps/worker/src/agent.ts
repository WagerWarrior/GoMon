import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { traceable } from "langsmith/traceable";
import { config } from "./config.ts";
import { correctMemory, enqueueForCall, forgetMemory, oid, PolicyDenied, promoteItem, vetoLocks, type Ctx } from "./governance.ts";
import { analyze, type Analysis } from "./llm.ts";
import { retrieve, type Retrieved } from "./retrieve.ts";
import type { CallItem, ItemKind, Say, Utterance } from "./shapes.ts";
import { parseWake } from "./wake.ts";
import { SPEAKING, templateFor } from "./templates.ts";
import { postToMeetingChat, resolveLink } from "./links.ts";
import { workspaceFor, type Workspace } from "./context.ts";

export type Stored = Utterance & { _id: ObjectId };

const RECENT_TURNS = 8;
/** Exact text the bot page pre-caches (SAY_PRECACHE="On it."); change only together with apps/bot-page. */
export const ACK_TEXT = "On it.";
/** The ack is spoken only if the answer is not ready by then, so it always comes before the answer and quick replies skip it. */
const ACK_DELAY_MS = 1500;
const NO_ANSWER = "I don't have anything on that yet.";
/** "drop the link", "send me the GitHub issue": a sharing verb plus a link-ish noun. "what's the latest issue" is a question, not this. */
const LINK_REQUEST = /\b(send|drop|share|post|paste|put|give|open)\b.*\b(link|url|github|issue|ticket|repo|repository|pull request|pr)\b|\b(link|url)\b/i;

/** Live agent state on the call document (listening | thinking | searching | answering), for the bot tile and the workspace. */
async function setState(ctx: Ctx, callId: string, state: "listening" | "thinking" | "searching" | "answering", detail: string): Promise<void> {
  await ctx.c.calls.updateOne({ _id: callId as never }, { $set: { agentState: { state, detail, at: new Date() } } });
}
/** Kinds that consensus may promote to canonical memory. Alternatives, risks, questions and actions stay as call items. */
const LOCKABLE_KINDS: ItemKind[] = ["decision", "requirement", "constraint", "interface"];

async function timing(ctx: Ctx, callId: string, stage: string, ms: number, utteranceId?: ObjectId) {
  await ctx.c.timings.insertOne({ callId, teamId: ctx.teamId, projectId: ctx.projectId, stage, ms: Math.round(ms), at: new Date(), utteranceId });
}

/** Gomon's speech goes through Atlas: the bot page streams `says` (GET /api/says/stream) and acks each one. */
export async function say(ctx: Ctx, callId: string, text: string, reason: Say["reason"], priority: Say["priority"] = "normal", utteranceId?: ObjectId): Promise<void> {
  const now = new Date();
  await ctx.c.says.insertOne({ sayId: randomUUID(), callId, teamId: ctx.teamId, projectId: ctx.projectId, text, priority, reason, status: "queued", createdAt: now, updatedAt: now, utteranceId, ...(ctx.voiceId ? { voiceId: ctx.voiceId } : {}) });
}

/** Things nobody asked Gomon to say out loud (lock progress) go to the meeting chat; spoken only if the chat is unavailable. */
async function notify(ctx: Ctx, callId: string, text: string, reason: Say["reason"], utteranceId?: ObjectId): Promise<void> {
  if (!(await postToMeetingChat(ctx, callId, `Gomon: ${text}`))) await say(ctx, callId, text, reason, "normal", utteranceId);
}

/** Resolve "new:<i>" or an open item id to an item id. */
function resolveRef(ref: string, created: ObjectId[], open: CallItem[]): ObjectId | null {
  if (!ref) return null;
  const m = /^new:(\d+)$/.exec(ref);
  if (m) return created[Number(m[1])] ?? null;
  return open.find((i) => String(i._id) === ref)?._id ?? null;
}

/** The model may cite a memory by id or by key ("D-12"); accept both, retrieved set first, then an exact active-key lookup. */
async function resolveMemory(ctx: Ctx, ref: string, memories: Retrieved[]): Promise<Retrieved | null> {
  if (!ref) return null;
  const hit = memories.find((m) => String(m._id) === ref || m.key?.toUpperCase() === ref.toUpperCase());
  if (hit) return hit;
  const id = oid(ref);
  const doc = await ctx.c.memories.findOne(
    { teamId: ctx.teamId, projectId: ctx.projectId, status: "active", ...(id ? { _id: id } : { key: ref.toUpperCase() }) },
    { projection: { key: 1, kind: 1, text: 1, origin: 1, version: 1 } },
  );
  return doc?._id ? { _id: doc._id, key: doc.key, kind: doc.kind, text: doc.text, origin: doc.origin, version: doc.version, score: 0, via: ["ref"] } : null;
}

/**
 * The pending committed utterances of one call (Recall sends one per sentence, faster than one analysis takes), handled as one
 * batch: retrieve governed memory (unless memory is off for this call, the A/B proof), run one structured analysis, then write
 * call items, conflicts, consensus state and spoken responses back to Atlas.
 */
async function handleBatchImpl(ctx: Ctx, batch: Stored[]): Promise<void> {
  const t0 = Date.now();
  const u = batch[batch.length - 1];
  const first = batch[0];
  const call = await ctx.c.calls.findOne({ _id: u.callId as never });
  const memoryEnabled = call?.memoryEnabled !== false;
  // The call's agent template decides persona, captured kinds, speaking budget, consensus mode, veto window and voice.
  const tpl = await templateFor(ctx.c, ctx.teamId, call?.templateId);
  const rules = SPEAKING[tpl.proactivity];
  ctx = { ...ctx, voiceId: tpl.voiceId };

  const [recentDesc, open] = await Promise.all([
    ctx.c.utterances.find({ callId: u.callId, seq: { $lt: first.seq } }).sort({ seq: -1 }).limit(RECENT_TURNS).toArray(),
    ctx.c.callItems.find({ callId: u.callId, status: { $in: ["proposed", "locking"] } }).sort({ createdAt: -1 }).limit(20).toArray(),
  ]);

  // Sound-alike wake detection (ASR never spells "Gomon"); the addressed utterance's speaker is the command actor.
  const wakes = batch.map((b) => ({ b, w: parseWake(b.text) })).filter((x) => x.w.addressed);
  const speaker = (wakes[wakes.length - 1]?.b ?? u).speaker.displayName;
  // Delayed acknowledgment for real requests (5+ words after the name): fires only if the answer takes longer than ACK_DELAY_MS.
  const ack: { timer?: NodeJS.Timeout; spoken: Promise<void> | null } = { spoken: null };
  if (wakes.some((x) => x.w.rest.split(/\s+/).filter(Boolean).length >= 5)) {
    ack.timer = setTimeout(() => { ack.spoken = say(ctx, u.callId, ACK_TEXT, "ack", "normal", u._id); }, ACK_DELAY_MS);
  }

  let a: Analysis;
  let memories: Retrieved[];
  let workspace: Workspace | null = null;
  let retrieveMs: number;
  let analyzeMs: number;
  try {
    const tR = Date.now();
    await setState(ctx, u.callId, wakes.length ? "searching" : "thinking", wakes.length ? "searching team memory" : "reading the conversation");
    const query = batch.map((b) => b.text).join(" ").slice(-600);
    // Previous calls, GitHub and Atlas stats only matter when someone is talking to Gomon; fetched alongside retrieval.
    [memories, workspace] = await Promise.all([
      memoryEnabled ? retrieve(ctx.c, ctx, query) : Promise.resolve([]),
      wakes.length ? workspaceFor(ctx, u.callId) : Promise.resolve(null),
    ]);
    retrieveMs = Date.now() - tR;

    const tA = Date.now();
    a = await analyze(
      recentDesc.reverse().map((r) => ({ id: String(r._id), speaker: r.speaker.displayName, text: r.text })),
      batch.map((b) => ({ id: String(b._id), speaker: b.speaker.displayName, text: b.text })),
      open.map((i) => ({ id: String(i._id), kind: i.kind, text: i.text, status: i.status })),
      memories.map((m) => ({ id: String(m._id), key: m.key, kind: m.kind, text: m.text })),
      wakes.map((x) => ({ id: String(x.b._id), heardAs: x.w.heardAs ?? "" })),
      { persona: tpl.persona, captureKinds: tpl.captureKinds },
      workspace,
    );
    analyzeMs = Date.now() - tA;
  } finally {
    clearTimeout(ack.timer);
  }
  if (ack.spoken) await ack.spoken;
  if (wakes.length) a.addressed = true;
  // Link requests are actions, not questions: if someone addressed Gomon and asked for a link, run share_link even when the
  // model chose to answer in words. A spoken key ("d 15") becomes the memory to look up.
  const lastWake = wakes[wakes.length - 1];
  if (lastWake && a.command.type === "none" && LINK_REQUEST.test(lastWake.w.rest)) {
    const key = /\b([a-z])[\s-]?(\d{1,3})\b/i.exec(lastWake.w.rest);
    a.command = { type: "share_link", memoryId: key ? `${key[1].toUpperCase()}-${key[2].padStart(2, "0")}` : "", itemRef: "", newText: "", query: lastWake.w.rest };
  }
  // ...and questions are not link requests: without a sharing verb, a model-chosen share_link becomes the spoken reply.
  if (lastWake && a.command.type === "share_link" && !LINK_REQUEST.test(lastWake.w.rest) && a.reply.trim()) {
    a.command = { type: "none", memoryId: "", itemRef: "", newText: "", query: "" };
  }

  const now = new Date();

  // 1. New scratch items (TTL-expiring until promoted).
  const created: ObjectId[] = [];
  for (const it of a.newItems.filter((n) => tpl.captureKinds.includes(n.kind))) {
    const r = await ctx.c.callItems.insertOne({
      callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, kind: it.kind, text: it.text, status: "proposed",
      sourceUtteranceIds: batch.map((b) => b._id), createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + config.scratchTtlMs),
    });
    created.push(r.insertedId);
  }
  const firstItemMs = Date.now() - t0;

  // 2. Conflicts and already-decided checks against canonical memory. All are recorded for the dashboard; the template's budget
  //    decides how many are spoken per batch (none when quiet, or when Gomon is about to answer a direct question).
  let spokenConflicts = a.addressed ? rules.conflictsPerBatch : 0;
  const ordered = [...a.conflicts].sort((x, y) => (x.kind === "conflict" ? 0 : 1) - (y.kind === "conflict" ? 0 : 1));
  for (const cf of ordered) {
    const itemId = resolveRef(cf.itemRef, created, open);
    const mem = await resolveMemory(ctx, cf.memoryId, memories);
    if (!itemId || !mem) continue;
    const recentSpoken = await ctx.c.conflicts.findOne({ callId: u.callId, memoryId: mem._id, spoken: true, createdAt: { $gte: new Date(Date.now() - config.conflictRepeatMs) } });
    // The only unprompted speech: a high-severity contradiction of canonical memory. "Already decided" stays on the dashboard.
    const speak = cf.kind === "conflict" && cf.severity === "high" && !recentSpoken && spokenConflicts < rules.conflictsPerBatch;
    const ins = await ctx.c.conflicts.updateOne(
      { callId: u.callId, itemId, memoryId: mem._id },
      { $setOnInsert: { callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, itemId, memoryId: mem._id, memoryKey: mem.key, severity: cf.severity, kind: cf.kind, spoken: speak, note: cf.note, createdAt: now } },
      { upsert: true },
    );
    if (ins.upsertedCount && speak) {
      spokenConflicts++;
      await say(ctx, u.callId, cf.note, "conflict", "high", u._id);
    }
  }

  // 3. Objection cancels any lock in its veto window.
  if (a.objection) {
    const vetoed = await vetoLocks(ctx, u.callId, speaker);
    if (vetoed.length) await say(ctx, u.callId, "Okay, holding off on that.", "lock_vetoed", "high", u._id);
  }

  // 4. Consensus: announce, then the sweeper promotes after the veto window unless someone objects. Safety gates: only
  //    lockable kinds, and never an item with an open high-severity conflict (that needs an explicit "lock it in").
  const agreedIds = a.agreement.itemRefs.map((r) => resolveRef(r, created, open)).filter((x): x is ObjectId => x !== null);
  if (agreedIds.length && !a.objection && tpl.consensus === "announce_veto") {
    const announced: string[] = [];
    const held: string[] = [];
    for (const id of agreedIds) {
      if (await ctx.c.conflicts.findOne({ callId: u.callId, itemId: id, severity: "high" })) {
        const it = await ctx.c.callItems.findOne({ _id: id });
        if (it) held.push(it.text);
        continue;
      }
      const it = await ctx.c.callItems.findOneAndUpdate(
        { _id: id, status: "proposed", kind: { $in: LOCKABLE_KINDS } },
        { $set: { status: "locking", lockAnnouncedAt: new Date(), vetoMs: tpl.vetoMs, agreedBy: [...new Set([...a.agreement.agreedBy, speaker])], updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (it) announced.push(it.text);
    }
    if (announced.length) await notify(ctx, u.callId, `locking in "${announced.map((t) => t.replace(/[.\s]+$/, "")).join("; ")}" in ${Math.round(tpl.vetoMs / 1000)} s. Say "wait" to stop it.`, "lock_announce", u._id);
    else if (held.length) await notify(ctx, u.callId, `not locking "${held.join("; ")}" on agreement alone: it conflicts with team memory. Say "lock it in" if you mean it.`, "command", u._id);
    if (held.length) await ctx.c.auditEvents.insertOne({ callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, at: new Date(), type: "lock_held", actor: speaker, reason: "agreement on an item with a high-severity conflict", ref: { items: held } });
  }

  // 5. Explicit commands. Policy is checked inside governance; denials are audited and spoken.
  try {
    const cmd = a.command;
    if (cmd.type === "lock_item") {
      const id = resolveRef(cmd.itemRef, created, open);
      const mem = id ? await promoteItem(ctx, id, speaker, "voice") : null;
      if (mem) await say(ctx, u.callId, `Got it, that's locked as ${mem.key}.`, "lock_done", "normal", u._id);
    } else if (cmd.type === "create_tickets" || cmd.type === "post_slack") {
      const type = cmd.type === "create_tickets" ? "create_issue" : "post_slack";
      const r = await enqueueForCall(ctx, type, u.callId, speaker);
      const what = type === "create_issue" ? (r.queued > 1 ? `${r.queued} GitHub issues` : "the GitHub issue") : "the Slack update";
      await say(ctx, u.callId, r.queued ? `On it, filing ${what} now.` : r.existing ? `Already done, those went out earlier.` : `Nothing's locked on this call yet, so there's nothing to file.`, "command", "normal", u._id);
    } else if (cmd.type === "correct_memory") {
      const id = (await resolveMemory(ctx, cmd.memoryId, memories))?._id;
      const mem = id && cmd.newText ? await correctMemory(ctx, id, cmd.newText, speaker, u.callId) : null;
      if (mem) await say(ctx, u.callId, `Updated ${mem.key ?? "that"}. I kept the old version in the history.`, "command", "normal", u._id);
    } else if (cmd.type === "forget_memory") {
      const id = (await resolveMemory(ctx, cmd.memoryId, memories))?._id;
      const mem = id ? await forgetMemory(ctx, id, speaker, u.callId) : null;
      if (mem) await say(ctx, u.callId, `Okay, ${mem.key ?? "that"} is forgotten. It stays in the audit log.`, "command", "normal", u._id);
    } else if (cmd.type === "share_link") {
      const mem = cmd.memoryId ? await resolveMemory(ctx, cmd.memoryId, memories) : null;
      const link = await resolveLink(ctx, u.callId, mem, cmd.query || cmd.memoryId);
      if (!link) await say(ctx, u.callId, "I couldn't find a link for that yet.", "command", "normal", u._id);
      else {
        const posted = await postToMeetingChat(ctx, u.callId, `${link.label}: ${link.url}`, link);
        await say(ctx, u.callId, posted ? "Dropped the link in the chat." : "I put the link in the workspace, the meeting chat didn't take it.", "command", "normal", u._id);
      }
    }
  } catch (e) {
    if (!(e instanceof PolicyDenied)) throw e;
    await say(ctx, u.callId, `Sorry ${speaker.split(" ")[0]}, I can't do that: ${e.result.reason}.`, "command", "normal", u._id);
  }

  // 6. Direct answer when addressed (skip if a command already produced the response). Grounding is enforced, not just asked:
  //    a grounded reply is spoken only if it cites at least one source that was actually in its context, and every memory key it
  //    says out loud exists. Conversational replies (about the call itself) need no source.
  if (a.addressed && a.command.type === "none" && a.reply.trim()) {
    let text = a.reply.trim();
    if (a.replyKind === "grounded") {
      const norm = (s: string) => s.trim().toUpperCase();
      const known = new Set([
        ...memories.flatMap((m) => [String(m._id), m.key ?? ""]), ...open.map((i) => String(i._id)), ...(workspace?.sources.map((s) => s.id) ?? []),
      ].filter(Boolean).map(norm));
      const keyLike = (s: string) => /^[A-Z]-\d{2,3}$/.test(s);
      const spokenKeys = [...text.matchAll(/\b([A-Z])-(\d{2,3})\b/g)].map((m) => m[0]);
      const askKeys = [...new Set([...a.sources.map(norm).filter(keyLike), ...spokenKeys])].filter((k) => !known.has(k));
      const activeKeys = askKeys.length
        ? new Set((await ctx.c.memories.find({ teamId: ctx.teamId, projectId: ctx.projectId, status: "active", key: { $in: askKeys } }).project({ key: 1 }).toArray()).map((m) => String(m.key)))
        : new Set<string>();
      const verified = a.sources.map(norm).filter((s) => known.has(s) || activeKeys.has(s));
      const badKey = spokenKeys.some((k) => !known.has(k) && !activeKeys.has(k));
      if (!verified.length || badKey) {
        await ctx.c.agentEvents.insertOne({ callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, at: new Date(), utteranceId: u._id, kind: "ungrounded_reply_dropped", reply: a.reply, cited: a.sources });
        text = NO_ANSWER;
      }
    }
    await setState(ctx, u.callId, "answering", a.replyKind === "grounded" && text !== NO_ANSWER ? "answering from team memory" : "answering");
    await say(ctx, u.callId, text, "addressed", "high", u._id);
  }

  // 7. Rare proactive alternative, rate-limited per call.
  if (a.suggestion && !a.addressed && rules.suggestionWindowMs !== null) {
    const last = await ctx.c.says.findOne({ callId: u.callId, reason: "suggestion", createdAt: { $gte: new Date(Date.now() - rules.suggestionWindowMs) } });
    if (!last) await say(ctx, u.callId, a.suggestion, "suggestion", "normal", u._id);
  }

  await setState(ctx, u.callId, "listening", "listening");
  const totalMs = Date.now() - t0;
  await Promise.all([
    ctx.c.agentEvents.insertOne({
      callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, at: new Date(), utteranceId: u._id, utteranceIds: batch.map((b) => b._id),
      batchSize: batch.length, wake: wakes.map((x) => x.w.heardAs), memoryEnabled,
      retrievedMemoryIds: memories.map((m) => m._id), retrievedKeys: memories.map((m) => m.key), analysis: a, model: config.analyzeModel,
    }),
    timing(ctx, u.callId, "queue", t0 - first.receivedAt.getTime(), u._id),
    timing(ctx, u.callId, "retrieve", retrieveMs, u._id),
    timing(ctx, u.callId, "analyze", analyzeMs, u._id),
    created.length ? timing(ctx, u.callId, "utterance_to_item", firstItemMs + (t0 - first.receivedAt.getTime()), u._id) : Promise.resolve(),
    timing(ctx, u.callId, "total", totalMs, u._id),
  ]);
}

/** Traced entry point: LangSmith records the call and utterance texts, not the database client. */
export function handleBatch(ctx: Ctx, batch: Stored[]): Promise<void> {
  const summary = { callId: batch[0]?.callId, utterances: batch.map((b) => `${b.speaker.displayName}: ${b.text}`) };
  return traceable((_s: typeof summary) => handleBatchImpl(ctx, batch), { name: "gomon.handleBatch", run_type: "chain" })(summary);
}

/** Promote items whose veto window elapsed. Runs on a timer, so a worker restart never strands a lock. */
export async function sweepLocks(ctx: Ctx): Promise<void> {
  const due = await ctx.c.callItems.find({ teamId: ctx.teamId, projectId: ctx.projectId, status: "locking" }).toArray();
  for (const it of due) {
    if (!it._id || !it.lockAnnouncedAt || it.lockAnnouncedAt.getTime() + (it.vetoMs ?? config.vetoMs) > Date.now()) continue;
    const actor = it.agreedBy?.[0] ?? "unknown";
    const call = await ctx.c.calls.findOne({ _id: it.callId as never }, { projection: { templateId: 1 } });
    const voiced: Ctx = { ...ctx, voiceId: (await templateFor(ctx.c, ctx.teamId, call?.templateId)).voiceId };
    try {
      const mem = await promoteItem(ctx, it._id, actor, "consensus");
      if (mem) await notify(voiced, it.callId, `locked ${mem.key}: ${it.text}`, "lock_done");
    } catch (e) {
      if (!(e instanceof PolicyDenied)) throw e;
      await ctx.c.callItems.updateOne({ _id: it._id, status: "locking" }, { $set: { status: "proposed", updatedAt: new Date() }, $unset: { lockAnnouncedAt: "" } });
      await notify(voiced, it.callId, `couldn't lock "${it.text}": ${e.result.reason}.`, "command");
    }
  }
}
