import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { traceable } from "langsmith/traceable";
import { config } from "./config.ts";
import { correctMemory, enqueueForCall, forgetMemory, oid, PolicyDenied, promoteItem, vetoLocks, type Ctx } from "./governance.ts";
import { analyze, type Analysis } from "./llm.ts";
import { retrieve, type Retrieved } from "./retrieve.ts";
import type { CallItem, Say, Utterance } from "./shapes.ts";
import { parseWake } from "./wake.ts";

export type Stored = Utterance & { _id: ObjectId };

const RECENT_TURNS = 8;

async function timing(ctx: Ctx, callId: string, stage: string, ms: number, utteranceId?: ObjectId) {
  await ctx.c.timings.insertOne({ callId, teamId: ctx.teamId, projectId: ctx.projectId, stage, ms: Math.round(ms), at: new Date(), utteranceId });
}

/** Gomon's speech goes through Atlas: the bot page streams `says` (GET /api/says/stream) and acks each one. */
export async function say(ctx: Ctx, callId: string, text: string, reason: Say["reason"], priority: Say["priority"] = "normal", utteranceId?: ObjectId): Promise<void> {
  const now = new Date();
  await ctx.c.says.insertOne({ sayId: randomUUID(), callId, teamId: ctx.teamId, projectId: ctx.projectId, text, priority, reason, status: "queued", createdAt: now, updatedAt: now, utteranceId });
}

/** Resolve "new:<i>" or an open item id to an item id. */
function resolveRef(ref: string, created: ObjectId[], open: CallItem[]): ObjectId | null {
  if (!ref) return null;
  const m = /^new:(\d+)$/.exec(ref);
  if (m) return created[Number(m[1])] ?? null;
  return open.find((i) => String(i._id) === ref)?._id ?? null;
}

/**
 * The pending committed utterances of one call (Recall sends one per sentence, faster than one analysis takes), handled as one
 * batch: retrieve governed memory (unless memory is off for this call, the A/B proof), run one structured analysis, then write
 * call items, conflicts, consensus state and spoken responses back to Atlas.
 */
export const handleBatch = traceable(async (ctx: Ctx, batch: Stored[]): Promise<void> => {
  const t0 = Date.now();
  const u = batch[batch.length - 1];
  const first = batch[0];
  const call = await ctx.c.calls.findOne({ _id: u.callId as never });
  const memoryEnabled = call?.memoryEnabled !== false;

  const [recentDesc, open] = await Promise.all([
    ctx.c.utterances.find({ callId: u.callId, seq: { $lt: first.seq } }).sort({ seq: -1 }).limit(RECENT_TURNS).toArray(),
    ctx.c.callItems.find({ callId: u.callId, status: { $in: ["proposed", "locking"] } }).sort({ createdAt: -1 }).limit(20).toArray(),
  ]);

  // Sound-alike wake detection (ASR never spells "Gomon"); the addressed utterance's speaker is the command actor.
  const wakes = batch.map((b) => ({ b, w: parseWake(b.text) })).filter((x) => x.w.addressed);
  const speaker = (wakes[wakes.length - 1]?.b ?? u).speaker.displayName;

  const tR = Date.now();
  const query = batch.map((b) => b.text).join(" ").slice(-600);
  const memories: Retrieved[] = memoryEnabled ? await retrieve(ctx.c, ctx, query) : [];
  const retrieveMs = Date.now() - tR;

  const tA = Date.now();
  const a: Analysis = await analyze(
    recentDesc.reverse().map((r) => ({ id: String(r._id), speaker: r.speaker.displayName, text: r.text })),
    batch.map((b) => ({ id: String(b._id), speaker: b.speaker.displayName, text: b.text })),
    open.map((i) => ({ id: String(i._id), kind: i.kind, text: i.text, status: i.status })),
    memories.map((m) => ({ id: String(m._id), key: m.key, kind: m.kind, text: m.text })),
    wakes.map((x) => ({ id: String(x.b._id), heardAs: x.w.heardAs ?? "" })),
  );
  if (wakes.length) a.addressed = true;
  const analyzeMs = Date.now() - tA;
  const now = new Date();

  // 1. New scratch items (TTL-expiring until promoted).
  const created: ObjectId[] = [];
  for (const it of a.newItems) {
    const r = await ctx.c.callItems.insertOne({
      callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, kind: it.kind, text: it.text, status: "proposed",
      sourceUtteranceIds: batch.map((b) => b._id), createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + config.scratchTtlMs),
    });
    created.push(r.insertedId);
  }
  const firstItemMs = Date.now() - t0;

  // 2. Conflicts and already-decided checks against canonical memory. All are recorded for the dashboard; at most ONE is spoken
  //    per batch (high severity, not spoken in the last window, and not when Gomon is about to answer a direct question).
  let spokeConflict = a.addressed;
  const ordered = [...a.conflicts].sort((x, y) => (x.kind === "conflict" ? 0 : 1) - (y.kind === "conflict" ? 0 : 1));
  for (const cf of ordered) {
    const itemId = resolveRef(cf.itemRef, created, open);
    const mem = memories.find((m) => String(m._id) === cf.memoryId);
    if (!itemId || !mem) continue;
    const recentSpoken = await ctx.c.conflicts.findOne({ callId: u.callId, memoryId: mem._id, spoken: true, createdAt: { $gte: new Date(Date.now() - config.conflictRepeatMs) } });
    const speak = cf.severity === "high" && !recentSpoken && !spokeConflict;
    const ins = await ctx.c.conflicts.updateOne(
      { callId: u.callId, itemId, memoryId: mem._id },
      { $setOnInsert: { callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, itemId, memoryId: mem._id, memoryKey: mem.key, severity: cf.severity, kind: cf.kind, spoken: speak, note: cf.note, createdAt: now } },
      { upsert: true },
    );
    if (ins.upsertedCount && speak) {
      spokeConflict = true;
      await say(ctx, u.callId, cf.note, cf.kind === "conflict" ? "conflict" : "already_decided", "high", u._id);
    }
  }

  // 3. Objection cancels any lock in its veto window.
  if (a.objection) {
    const vetoed = await vetoLocks(ctx, u.callId, speaker);
    if (vetoed.length) await say(ctx, u.callId, "Okay, holding off on that.", "lock_vetoed", "high", u._id);
  }

  // 4. Consensus: announce, then the sweeper promotes after the veto window unless someone objects.
  const agreedIds = a.agreement.itemRefs.map((r) => resolveRef(r, created, open)).filter((x): x is ObjectId => x !== null);
  if (agreedIds.length && !a.objection) {
    const announced: string[] = [];
    for (const id of agreedIds) {
      const it = await ctx.c.callItems.findOneAndUpdate(
        { _id: id, status: "proposed" },
        { $set: { status: "locking", lockAnnouncedAt: new Date(), vetoMs: config.vetoMs, agreedBy: [...new Set([...a.agreement.agreedBy, speaker])], updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (it) announced.push(it.text);
    }
    if (announced.length) await say(ctx, u.callId, `Locking in: ${announced.map((t) => t.replace(/[.\s]+$/, "")).join("; ")}. Say wait to stop me.`, "lock_announce", "high", u._id);
  }

  // 5. Explicit commands. Policy is checked inside governance; denials are audited and spoken.
  try {
    const cmd = a.command;
    if (cmd.type === "lock_item") {
      const id = resolveRef(cmd.itemRef, created, open);
      const mem = id ? await promoteItem(ctx, id, speaker, "voice") : null;
      if (mem) await say(ctx, u.callId, `Locked as ${mem.key}.`, "lock_done", "normal", u._id);
    } else if (cmd.type === "create_tickets" || cmd.type === "post_slack") {
      const type = cmd.type === "create_tickets" ? "create_issue" : "post_slack";
      const r = await enqueueForCall(ctx, type, u.callId, speaker);
      const what = type === "create_issue" ? "GitHub issue" : "Slack post";
      await say(ctx, u.callId, r.queued ? `Queued ${r.queued} ${what}${r.queued > 1 ? "s" : ""}.` : r.existing ? `Those are already queued.` : `There are no locked decisions from this call yet.`, "command", "normal", u._id);
    } else if (cmd.type === "correct_memory") {
      const id = oid(cmd.memoryId);
      const mem = id && cmd.newText ? await correctMemory(ctx, id, cmd.newText, speaker, u.callId) : null;
      if (mem) await say(ctx, u.callId, `Corrected ${mem.key ?? "that"}; version ${mem.version} is now the record.`, "command", "normal", u._id);
    } else if (cmd.type === "forget_memory") {
      const id = oid(cmd.memoryId);
      const mem = id ? await forgetMemory(ctx, id, speaker, u.callId) : null;
      if (mem) await say(ctx, u.callId, `Forgotten ${mem.key ?? "that"}. History is kept for audit.`, "command", "normal", u._id);
    }
  } catch (e) {
    if (!(e instanceof PolicyDenied)) throw e;
    await say(ctx, u.callId, `I can't do that for ${speaker}: ${e.result.reason}.`, "command", "normal", u._id);
  }

  // 6. Direct answer when addressed (skip if a command already produced the response).
  if (a.addressed && a.reply && a.command.type === "none") await say(ctx, u.callId, a.reply, "addressed", "high", u._id);

  // 7. Rare proactive alternative, rate-limited per call.
  if (a.suggestion && !a.addressed) {
    const last = await ctx.c.says.findOne({ callId: u.callId, reason: "suggestion", createdAt: { $gte: new Date(Date.now() - config.suggestionWindowMs) } });
    if (!last) await say(ctx, u.callId, a.suggestion, "suggestion", "normal", u._id);
  }

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
}, { name: "gomon.handleBatch", run_type: "chain" });

/** Promote items whose veto window elapsed. Runs on a timer, so a worker restart never strands a lock. */
export async function sweepLocks(ctx: Ctx): Promise<void> {
  const due = await ctx.c.callItems.find({ teamId: ctx.teamId, projectId: ctx.projectId, status: "locking" }).toArray();
  for (const it of due) {
    if (!it._id || !it.lockAnnouncedAt || it.lockAnnouncedAt.getTime() + (it.vetoMs ?? config.vetoMs) > Date.now()) continue;
    const actor = it.agreedBy?.[0] ?? "unknown";
    try {
      const mem = await promoteItem(ctx, it._id, actor, "consensus");
      if (mem) await say(ctx, it.callId, `Locked ${mem.key}.`, "lock_done");
    } catch (e) {
      if (!(e instanceof PolicyDenied)) throw e;
      await ctx.c.callItems.updateOne({ _id: it._id, status: "locking" }, { $set: { status: "proposed", updatedAt: new Date() }, $unset: { lockAnnouncedAt: "" } });
      await say(ctx, it.callId, `I couldn't lock that: ${e.result.reason}.`, "command");
    }
  }
}
