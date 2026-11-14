/**
 * Gomon worker.
 *   POST /api/utterances          committed transcript segment in (Recall webhook relay, bot page, or typed)
 *   POST /api/calls               create/ensure a call            PATCH /api/calls/:id  { memoryEnabled }  (A/B memory proof)
 *   GET  /api/says/stream?callId= SSE of Gomon's speech for the bot page     POST /api/says/:sayId/ack { status }
 *   POST /api/meetings            send a Recall bot into a Meet   POST /api/meetings/:callId/leave  take it out, end the call
 *   GET/POST /api/projects        the team's projects (company context + working projects)
 * Each call belongs to one project (calls.projectId) and is processed in that project's scope; one change stream covers
 * the whole team. Utterance inserts wake the agent through it (resume token in stream_offsets); a sweep catches anything
 * missed, and a timer promotes consensus locks after their veto window.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { MongoServerError, type ObjectId, type ResumeToken } from "mongodb";
import { config } from "./config.ts";
import { cols, connect } from "./db.ts";
import { handleBatch, sweepLocks, type Stored } from "./agent.ts";
import { checkPolicy, PolicyDenied, type Ctx } from "./governance.ts";
import type { AgentTemplate, Say, Utterance } from "./shapes.ts";
import { DEFAULT_TEMPLATE_ID, parseTemplateInput } from "./templates.ts";
import { parseWake } from "./wake.ts";
import { login, logout, userFromToken, userIdForDisplayName, visibleCallsFilter, type PublicUser } from "./auth.ts";
import { heard, startRecallVoice, stopSpeaking } from "./voice.ts";
import { createBot, leaveBot } from "./recall.ts";
import { createProjectWithBoard } from "./projects.ts";
import { COMPANY_PROJECT } from "./scope.ts";
import { startAnnouncer } from "./announce.ts";
import { handleEars } from "./ears.ts";
import { fastReply, wantsFastReply } from "./fast.ts";
import { sweepSpeakers } from "./speakers.ts";

const { client, db } = await connect();
const c = cols(db);
/** Base context; `projectId` here is only the fallback for calls without one. Per-call work uses callCtx(). */
const ctx: Ctx = { client, c, teamId: config.teamId, projectId: config.projectId };
/** Speaks GitHub/Slack results on the live call and drops the link in the meeting chat, once per action. */
startAnnouncer(ctx);
/** One stream per team: calls of every project wake the same worker. */
const STREAM_ID = `worker-utterances:${config.teamId}`;
/** Identifies this process on claimed utterances, so a second worker on the same database is visible. */
const WORKER_ID = `${hostname()}:${process.pid}`;

// ---------- processing: one batch at a time per call; everything that arrived meanwhile is the next batch ----------
const MAX_BATCH = 8;
const MERGE_QUIET_MS = Number(process.env.MERGE_QUIET_MS || 1200);
const MERGE_MAX_MS = Number(process.env.MERGE_MAX_MS || 3500);
/**
 * After Gomon answers, questions/requests within this window are treated as addressed even without the name. Off by default
 * (Max, Nov 14): in the live demo it answered people talking to each other ("Is that a larf? Yeah, it"). FOLLOW_UP_MS=20000 turns it on.
 */
const FOLLOW_UP_MS = Number(process.env.FOLLOW_UP_MS || 0);
const FOLLOW_UP = /\?\s*$|^(what|why|how|when|where|who|which|can|could|would|will|is|are|do|does|did|should|tell|show|give|post|drop|send|share|create|file|lock|and what|what about)\b/i;
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
const running = new Set<string>();
const again = new Set<string>();

function schedule(callId: string): void {
  if (running.has(callId)) { again.add(callId); return; }
  running.add(callId);
  void (async () => {
    try {
      do { again.delete(callId); while (await processPending(callId)); } while (again.has(callId));
    } catch (e) { console.error("[agent]", e); }
    finally { running.delete(callId); }
  })();
}

/**
 * Claim this call's unprocessed utterances (atomically, by token) and handle them as one batch. Returns false when none.
 * Recall splits speech into tiny segments ("yeah", "ness"), so unless someone addressed Gomon we wait for a short quiet gap
 * (MERGE_QUIET_MS since the newest segment, at most MERGE_MAX_MS since the oldest) and analyze the merged run once.
 */
async function processPending(callId: string): Promise<boolean> {
  // Unclaimed, or held for this worker since ingest (postUtterance). Held docs look claimed to any other worker.
  const pendingFilter = { callId, processedAt: { $exists: false }, claimToken: { $exists: false }, $or: [{ claimedAt: { $exists: false } }, { heldBy: WORKER_ID }] };
  for (;;) {
    const pending = await c.utterances.find(pendingFilter, { projection: { text: 1, receivedAt: 1, source: 1 } }).sort({ seq: 1 }).limit(MAX_BATCH).toArray();
    if (!pending.length) return false;
    if (pending.length >= MAX_BATCH || pending.some((p) => parseWake(p.text).addressed)) break;
    // Scribe commits whole turns, so its merge wait is short; Recall sends sentence fragments and needs the longer window.
    const scribe = pending.every((p) => p.source === "scribe");
    const quietMs = scribe ? 300 : MERGE_QUIET_MS;
    const maxMs = scribe ? 1500 : MERGE_MAX_MS;
    const now = Date.now();
    const quietFor = now - pending[pending.length - 1].receivedAt.getTime();
    const waited = now - pending[0].receivedAt.getTime();
    if (quietFor >= quietMs || waited >= maxMs) break;
    await sleep(Math.min(quietMs - quietFor, maxMs - waited) + 20);
  }
  const ids = (await c.utterances.find(pendingFilter, { projection: { _id: 1 } }).sort({ seq: 1 }).limit(MAX_BATCH).toArray()).map((d) => d._id);
  if (!ids.length) return false;
  const claimToken = randomUUID();
  await c.utterances.updateMany({ _id: { $in: ids }, ...pendingFilter }, { $set: { claimedAt: new Date(), claimToken, claimedBy: WORKER_ID } });
  const batch = (await c.utterances.find({ claimToken }).sort({ seq: 1 }).toArray()) as Stored[];
  if (!batch.length) return true;
  try {
    await handleBatch(await callCtx(callId), batch);
    await c.utterances.updateMany({ claimToken }, { $set: { processedAt: new Date() } });
  } catch (e) {
    console.error(`[agent] batch of ${batch.length} in ${callId} failed:`, e);
    await c.utterances.updateMany({ claimToken }, { $set: { processedAt: new Date(), error: String(e instanceof Error ? e.message : e) } });
  }
  return true;
}

/** The scope a call is processed in: its own project (legacy calls without one fall back to PROJECT_ID). */
async function callCtx(callId: string): Promise<Ctx> {
  const call = await c.calls.findOne({ _id: callId as never }, { projection: { projectId: 1 } });
  return { ...ctx, projectId: typeof call?.projectId === "string" ? call.projectId : config.projectId };
}

/** One team-wide sweep: sweepLocks promotes each item into its own project. */
async function sweepAllLocks(): Promise<void> {
  await sweepLocks(ctx);
}

async function catchUp(): Promise<void> {
  const stale = new Date(Date.now() - 120_000);
  await c.utterances.updateMany(
    { teamId: config.teamId, processedAt: { $exists: false }, claimedAt: { $lt: stale } },
    { $unset: { claimedAt: "", claimToken: "" } },
  );
  const calls = await c.utterances.distinct("callId", { teamId: config.teamId, processedAt: { $exists: false } });
  for (const callId of calls) schedule(callId);
}

async function watchUtterances(): Promise<void> {
  const saved = await c.streamOffsets.findOne({ _id: STREAM_ID });
  const pipeline = [{ $match: { operationType: "insert", "fullDocument.teamId": config.teamId } }];
  const open = (resumeAfter?: unknown) => c.utterances.watch(pipeline, resumeAfter ? { resumeAfter: resumeAfter as ResumeToken } : {});
  let stream = open(saved?.token);
  stream.on("error", (e) => {
    console.warn("[stream] error, reopening without token:", e.message);
    stream = open();
  });
  console.log(`[stream] watching utterances${saved ? " (resumed from stored token)" : ""}`);
  for await (const ev of stream) {
    if (ev.operationType !== "insert") continue;
    schedule(ev.fullDocument.callId);
    await c.streamOffsets.updateOne({ _id: STREAM_ID }, { $set: { token: ev._id, at: new Date() } }, { upsert: true });
  }
}

// ---------- HTTP ----------
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}
function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

type CallOpts = { title?: string; speaker?: string; meetingUrl?: string; templateId?: string; botId?: string; ownerUserId?: string; projectId?: string };
/** Upsert the call (first utterance or explicit create); returns the next utterance seq and the call's project. */
async function ensureCall(callId: string, opts: CallOpts = {}): Promise<{ seq: number; projectId: string }> {
  const { title, speaker, meetingUrl, templateId, botId, ownerUserId, projectId } = opts;
  const speakerUserId = speaker ? await userIdForDisplayName(c, config.teamId, speaker) : null;
  const addToSet: Record<string, string> = {};
  if (speaker) addToSet.participants = speaker;
  if (speakerUserId) addToSet.participantUserIds = speakerUserId;
  const call = await c.calls.findOneAndUpdate(
    { _id: callId as never },
    {
      $inc: { utteranceSeq: speaker ? 1 : 0 },
      $setOnInsert: {
        teamId: config.teamId, projectId: projectId ?? config.projectId, title: title ?? "Design call", status: "live", startedAt: new Date(), memoryEnabled: true,
        templateId: templateId ?? DEFAULT_TEMPLATE_ID, ...(meetingUrl ? { meetingUrl } : {}), ...(ownerUserId ? { ownerUserId } : {}),
      },
      ...(botId ? { $set: { botId } } : {}),
      ...(Object.keys(addToSet).length ? { $addToSet: addToSet } : {}),
    },
    { upsert: true, returnDocument: "after" },
  );
  return { seq: Number(call?.utteranceSeq ?? 0), projectId: typeof call?.projectId === "string" ? call.projectId : config.projectId };
}

async function postUtterance(b: Record<string, unknown>) {
  const callId = str(b.callId), text = str(b.text);
  const speakerName = str((b.speaker as Record<string, unknown> | undefined)?.displayName) ?? str(b.speaker);
  if (!callId || !text || !speakerName) return { status: 400, data: { error: "callId, text and speaker.displayName are required" } };
  const source = (["recall", "scribe", "typed"] as const).find((s) => s === b.source) ?? "typed";
  const sourceKey = str(b.sourceKey) ?? randomUUID();
  // Recall sourceKeys are recall:<botId>:<participantId>:<start>; the bot id lets Gomon post to the meeting chat.
  const botId = /^recall:([^:]+):/.exec(sourceKey)?.[1];
  const { seq, projectId } = await ensureCall(callId, { speaker: speakerName, botId });
  // Follow-up window: right after Gomon answered, a question or request without the name is still addressed to it.
  const bare = text.replace(/^(\s*(um+|uh+|so|okay|ok|yeah|and|but|hmm+|right)[,.]?\s+)+/i, "");
  const woke = parseWake(text).addressed;
  const followUp = FOLLOW_UP_MS > 0 && !woke && FOLLOW_UP.test(bare)
    && !!(await c.says.findOne({ callId, reason: { $in: ["addressed", "command"] }, createdAt: { $gte: new Date(Date.now() - FOLLOW_UP_MS) } }));
  const fast = wantsFastReply(followUp ? `Gomon, ${bare}` : text);
  const doc: Utterance = {
    callId, teamId: config.teamId, projectId, seq, sourceKey,
    speaker: { displayName: speakerName }, text, source, receivedAt: new Date(),
    // Held by the ingesting worker: a stray or older worker sees it as claimed (they skip claimedAt) and never splits the call.
    claimedAt: new Date(), heldBy: WORKER_ID,
    ...(fast ? { fastReply: true } : {}),
    ...(followUp ? { followUp: true } : {}),
    ...(str(b.startedAt) ? { startedAt: new Date(String(b.startedAt)) } : {}), ...(str(b.endedAt) ? { endedAt: new Date(String(b.endedAt)) } : {}),
  };
  try {
    const r = await c.utterances.insertOne(doc);
    // Heard its name: confirm at once (chime in the meeting, Thinking card, state line), before any model call.
    if (woke && source !== "typed") void heard(c, callId, speakerName).catch((e) => console.error("[heard]", e instanceof Error ? e.message : e));
    // Questions to Gomon are answered now, not after the queue and the full analysis.
    if (fast) void callCtx(callId).then((cx) => fastReply(cx, { _id: r.insertedId, callId, seq, text, speaker: doc.speaker })).catch((e) => console.error("[fast]", e instanceof Error ? e.message : e));
    return { status: 201, data: { utteranceId: String(r.insertedId), seq, duplicate: false } };
  } catch (e) {
    if (e instanceof MongoServerError && e.code === 11000) return { status: 200, data: { duplicate: true } };
    throw e;
  }
}

function streamSays(req: IncomingMessage, res: ServerResponse, callId: string): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "access-control-allow-origin": "*" });
  const emit = (s: Say) => res.write(`event: say\ndata: ${JSON.stringify({ sayId: s.sayId, text: s.text, priority: s.priority, reason: s.reason, createdAt: s.createdAt, ...(s.voiceId ? { voiceId: s.voiceId } : {}) })}\n\n`);
  void c.says.find({ callId, status: "queued" }).sort({ createdAt: 1 }).forEach((s) => { emit(s); });
  const cs = c.says.watch([{ $match: { operationType: "insert", "fullDocument.callId": callId } }]);
  cs.on("change", (ev) => { if (ev.operationType === "insert") emit(ev.fullDocument); });
  // Agent state (listening | thinking | searching | answering) for the bot tile: `event: state`.
  const st = c.calls.watch([{ $match: { operationType: "update", "documentKey._id": callId, "updateDescription.updatedFields.agentState": { $exists: true } } }]);
  st.on("change", (ev) => {
    if (ev.operationType === "update") res.write(`event: state\ndata: ${JSON.stringify(ev.updateDescription?.updatedFields?.agentState ?? {})}\n\n`);
  });
  const ka = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  req.on("close", () => { clearInterval(ka); void cs.close(); void st.close(); });
}

async function audit(type: string, actor: string, reason: string, ref: Record<string, unknown>, callId?: string, projectId = config.projectId): Promise<void> {
  await c.auditEvents.insertOne({ teamId: config.teamId, projectId, at: new Date(), type, actor, reason, ref, ...(callId ? { callId } : {}) });
}

const errText = (e: unknown) => String(e instanceof Error ? e.message : e);
const newCallId = () => `call-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 4)}`;

/** A call must belong to an active working project of this team; company context is read by every call, never a call's home. */
async function projectError(projectId: string): Promise<string | null> {
  if (projectId === COMPANY_PROJECT) return "company context is not a working project; pick a project";
  const p = await c.projects.findOne({ _id: projectId as never, teamId: config.teamId, status: "active" }, { projection: { _id: 1 } });
  return p ? null : `unknown or archived project ${projectId}`;
}

/** Who is asking: the signed-in user's team member name (policies key on members.displayName), else the workspace's `actor`. */
async function requester(me: PublicUser | null, b: Record<string, unknown>): Promise<string | undefined> {
  if (!me) return str(b.actor);
  const m = await c.members.findOne({ teamId: config.teamId, displayName: { $in: me.displayNames } }, { projection: { displayName: 1 } });
  return m ? String(m.displayName) : me.name;
}

type Reply = { status: number; data: unknown };

/**
 * Start a meeting: policy start_meeting, create the call in its project, then dispatch the Recall bot for it. The call row
 * exists before the bot, so the bot's first transcript lands in the right project; a failed dispatch marks the call failed.
 */
async function startMeeting(b: Record<string, unknown>, me: PublicUser | null): Promise<Reply> {
  const meetingUrl = str(b.meetingUrl);
  if (!meetingUrl || !/^https:\/\//.test(meetingUrl)) return { status: 400, data: { error: "meetingUrl (https) required" } };
  // No PUBLIC_BASE_URL is fine: the bot speaks and shows its card, and the local ears page transcribes (recall.ts).
  if (!config.recall.apiKey) return { status: 503, data: { error: "Recall is not configured: set RECALL_API_KEY" } };
  const actor = await requester(me, b);
  if (!actor) return { status: 400, data: { error: "actor required (or sign in)" } };
  const projectId = str(b.projectId) ?? config.projectId;
  const bad = await projectError(projectId);
  if (bad) return { status: 400, data: { error: bad } };
  const templateId = str(b.templateId);
  if (templateId && !(await c.agentTemplates.findOne({ _id: templateId, teamId: config.teamId }))) return { status: 400, data: { error: `unknown template ${templateId}` } };
  const policy = await checkPolicy({ ...ctx, projectId }, actor, "start_meeting");
  if (!policy.allowed) {
    await audit("policy_denied", actor, policy.reason, { action: "start_meeting", meetingUrl }, undefined, projectId);
    return { status: 403, data: { error: "policy_denied", reason: policy.reason } };
  }
  const callId = newCallId();
  const title = str(b.title) ?? "Design call";
  const ownerUserId = me?._id ?? (await userIdForDisplayName(c, config.teamId, actor)) ?? undefined;
  await ensureCall(callId, { title, meetingUrl, templateId, projectId, ownerUserId });
  let botId: string;
  try {
    botId = await createBot(meetingUrl, callId);
  } catch (e) {
    const error = errText(e);
    await c.calls.updateOne({ _id: callId as never }, { $set: { status: "failed", error, endedAt: new Date() } });
    await audit("meeting_failed", actor, error, { meetingUrl }, callId, projectId);
    return { status: 502, data: { error, callId } };
  }
  await c.calls.updateOne({ _id: callId as never }, { $set: { botId, requestedBy: actor } });
  await audit("meeting_started", actor, `${title} (${projectId})`, { botId, meetingUrl, policyId: policy.policyId, templateId: templateId ?? DEFAULT_TEMPLATE_ID }, callId, projectId);
  return { status: 201, data: { callId, botId, projectId } };
}

/** Ending a call: Gomon stops mid-sentence and nothing it had queued is spoken. */
async function silence(callId: string): Promise<void> {
  await stopSpeaking(c, callId, "meeting_ended");
  await c.says.updateMany({ callId, status: { $in: ["queued", "started"] } }, { $set: { status: "cancelled", cancelledBy: "meeting_ended", updatedAt: new Date() } });
}

/**
 * Any dashboard can end a call by writing `status: "ended"` with `endRequested: true` (web POST /api/sessions/:id/end). This
 * worker holds the voice and the Recall key, so it stops talking and takes the bot out, whichever machine the click came from.
 */
function watchEndRequests(): void {
  const cs = c.calls.watch([{ $match: { operationType: "update", "updateDescription.updatedFields.endRequested": true } }], { fullDocument: "updateLookup" });
  cs.on("change", (ev) => {
    if (ev.operationType !== "update" || !ev.fullDocument) return;
    const call = ev.fullDocument;
    const callId = String(call._id);
    void (async () => {
      await silence(callId);
      let recallError: string | undefined;
      if (typeof call.botId === "string") { try { await leaveBot(call.botId); } catch (e) { recallError = errText(e); } }
      await c.calls.updateOne({ _id: callId as never }, { $unset: { endRequested: "" }, $set: { botLeftAt: new Date(), ...(recallError ? { botLeaveError: recallError } : {}) } });
      console.log(`[end] ${callId} ended from a dashboard${recallError ? ` (Recall: ${recallError})` : ""}`);
    })().catch((e) => console.error("[end]", e));
  });
  cs.on("error", (e) => console.warn("[end] stream error:", e.message));
}

/** Take Gomon out of the meeting and end the call. The call ends even if Recall reports the bot already gone. */
async function leaveMeeting(callId: string, b: Record<string, unknown>, me: PublicUser | null): Promise<Reply> {
  const call = await c.calls.findOne({ _id: callId as never, teamId: config.teamId });
  if (!call) return { status: 404, data: { error: "not found" } };
  const actor = (await requester(me, b)) ?? "workspace";
  const botId = typeof call.botId === "string" ? call.botId : undefined;
  let recallError: string | undefined;
  await silence(callId);
  if (botId) {
    try { await leaveBot(botId); } catch (e) { recallError = errText(e); }
  }
  await c.calls.updateOne({ _id: callId as never }, { $set: { status: "ended", endedAt: new Date() } });
  await audit("meeting_ended", actor, recallError ? `bot leave failed: ${recallError}` : botId ? "Gomon left the meeting" : "ended (no bot)", { botId: botId ?? null }, callId, typeof call.projectId === "string" ? call.projectId : config.projectId);
  return { status: 200, data: { callId, status: "ended", botId: botId ?? null, ...(recallError ? { recallError } : {}) } };
}

/** Active projects of the team (company context included, flagged) with active-memory and call counts. */
async function listProjects(): Promise<unknown[]> {
  const teamId = config.teamId;
  const [projects, mems, calls] = await Promise.all([
    c.projects.find({ teamId, status: "active" }).sort({ createdAt: 1 }).toArray(),
    c.memories.aggregate<{ _id: string; n: number }>([{ $match: { teamId, status: "active" } }, { $group: { _id: "$projectId", n: { $sum: 1 } } }]).toArray(),
    c.calls.aggregate<{ _id: string; n: number }>([{ $match: { teamId } }, { $group: { _id: "$projectId", n: { $sum: 1 } } }]).toArray(),
  ]);
  const m = new Map(mems.map((r) => [r._id, r.n])), k = new Map(calls.map((r) => [r._id, r.n]));
  return projects.map((p) => ({ ...p, company: String(p._id) === COMPANY_PROJECT, memories: m.get(String(p._id)) ?? 0, calls: k.get(String(p._id)) ?? 0 }));
}

/** Create a project from the workspace; createProjectWithBoard checks create_project, audits, and queues the GitHub board. */
async function postProject(b: Record<string, unknown>, me: PublicUser | null): Promise<Reply> {
  const name = str(b.name);
  if (!name) return { status: 400, data: { error: "name required" } };
  const actor = await requester(me, b);
  if (!actor) return { status: 400, data: { error: "actor required (or sign in)" } };
  try {
    const r = await createProjectWithBoard(ctx, { name, description: str(b.description), actor });
    return r.created ? { status: 201, data: r } : { status: 409, data: { ...r, error: `a project named "${r.name}" already exists` } };
  } catch (e) {
    if (e instanceof PolicyDenied) return { status: 403, data: { error: "policy_denied", reason: e.result.reason } };
    throw e;
  }
}

/** Create (no id) or update (id) an agent template. Leads only (policy manage_templates); every change is versioned and audited. */
async function saveTemplate(b: Record<string, unknown>, id?: string): Promise<{ status: number; data: unknown }> {
  const actor = str(b.actor);
  if (!actor) return { status: 400, data: { error: "actor required" } };
  const parsed = parseTemplateInput(b);
  if (!parsed.ok) return { status: 400, data: { error: "invalid template", details: parsed.errors } };
  const policy = await checkPolicy(ctx, actor, "manage_templates");
  if (!policy.allowed) {
    await audit("policy_denied", actor, policy.reason, { action: "manage_templates", templateId: id });
    return { status: 403, data: { error: "policy_denied", reason: policy.reason } };
  }
  const now = new Date();
  if (id) {
    const r = await c.agentTemplates.findOneAndUpdate(
      { _id: id, teamId: config.teamId },
      { $set: { ...parsed.value, updatedAt: now, updatedBy: actor }, $inc: { version: 1 } },
      { returnDocument: "after" },
    );
    if (!r) return { status: 404, data: { error: "not found" } };
    await audit("template_updated", actor, `${r.name} v${r.version}`, { templateId: id, version: r.version });
    return { status: 200, data: r };
  }
  const slug = parsed.value.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "template";
  const doc: AgentTemplate = { _id: `${slug}-${randomUUID().slice(0, 4)}`, teamId: config.teamId, ...parsed.value, version: 1, createdAt: now, updatedAt: now, updatedBy: actor };
  try {
    await c.agentTemplates.insertOne(doc);
  } catch (e) {
    if (e instanceof MongoServerError && e.code === 11000) return { status: 409, data: { error: `a template named "${doc.name}" already exists` } };
    throw e;
  }
  await audit("template_created", actor, doc.name, { templateId: doc._id });
  return { status: 201, data: doc };
}

const server = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization, x-session-token");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  const url = new URL(req.url ?? "/", "http://localhost");
  // Local capture page (ElevenLabs Scribe): loopback-only, so it runs before the WORKER_TOKEN check.
  if (await handleEars(req, res, url, c, postUtterance, (b) => startMeeting(b, null)).catch((e) => { console.error("[ears]", e); send(res, 500, { error: "ears failed" }); return true; })) return;
  if (config.workerToken) {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
    if (token !== config.workerToken && url.pathname !== "/healthz") return send(res, 401, { error: "unauthorized" });
  }
  try {
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, db: config.dbName, team: config.teamId, project: config.projectId });
    if (req.method === "POST" && url.pathname === "/api/utterances") {
      const r = await postUtterance(await body(req));
      return send(res, r.status, r.data);
    }
    // ---------- users (Atlas): login, me, my calls ----------
    const sessionToken = req.headers["x-session-token"];
    const me = await userFromToken(c, typeof sessionToken === "string" ? sessionToken : undefined);
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const b = await body(req);
      const r = str(b.email) && str(b.password) ? await login(c, String(b.email), String(b.password)) : null;
      if (!r) return send(res, 401, { error: "invalid email or password" });
      await audit("user_login", r.user.name, "login", { userId: r.user._id });
      return send(res, 200, r);
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      if (typeof sessionToken === "string") await logout(c, sessionToken);
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/me") return me ? send(res, 200, me) : send(res, 401, { error: "not signed in" });
    if (req.method === "GET" && url.pathname === "/api/me/calls") {
      if (!me) return send(res, 401, { error: "not signed in" });
      const calls = await c.calls.find(visibleCallsFilter(me), { projection: { title: 1, status: 1, startedAt: 1, participants: 1, ownerUserId: 1, templateId: 1, agentState: 1, projectId: 1 } })
        .sort({ startedAt: -1 }).limit(100).toArray();
      return send(res, 200, calls);
    }
    if (req.method === "POST" && url.pathname === "/api/calls") {
      const b = await body(req);
      const templateId = str(b.templateId);
      if (templateId && !(await c.agentTemplates.findOne({ _id: templateId, teamId: config.teamId }))) return send(res, 400, { error: `unknown template ${templateId}` });
      const projectId = str(b.projectId);
      const bad = projectId ? await projectError(projectId) : null;
      if (bad) return send(res, 400, { error: bad });
      const callId = str(b.callId) ?? newCallId();
      const call = await ensureCall(callId, { title: str(b.title), meetingUrl: str(b.meetingUrl), templateId, ownerUserId: me?._id, projectId });
      return send(res, 201, { callId, projectId: call.projectId, templateId: templateId ?? DEFAULT_TEMPLATE_ID, ownerUserId: me?._id ?? null });
    }
    if (req.method === "POST" && url.pathname === "/api/meetings") {
      const r = await startMeeting(await body(req), me);
      return send(res, r.status, r.data);
    }
    const leaveMatch = /^\/api\/meetings\/([^/]+)\/leave$/.exec(url.pathname);
    if (req.method === "POST" && leaveMatch) {
      const r = await leaveMeeting(decodeURIComponent(leaveMatch[1]), await body(req), me);
      return send(res, r.status, r.data);
    }
    if (req.method === "GET" && url.pathname === "/api/projects") return send(res, 200, await listProjects());
    if (req.method === "POST" && url.pathname === "/api/projects") {
      const r = await postProject(await body(req), me);
      return send(res, r.status, r.data);
    }
    const callMatch = /^\/api\/calls\/([^/]+)$/.exec(url.pathname);
    if (req.method === "PATCH" && callMatch) {
      const b = await body(req);
      const callId = decodeURIComponent(callMatch[1]);
      const set: Record<string, unknown> = {};
      if (typeof b.memoryEnabled === "boolean") set.memoryEnabled = b.memoryEnabled;
      const templateId = str(b.templateId);
      if (templateId) {
        if (!(await c.agentTemplates.findOne({ _id: templateId, teamId: config.teamId }))) return send(res, 400, { error: `unknown template ${templateId}` });
        set.templateId = templateId;
      }
      if (!Object.keys(set).length) return send(res, 400, { error: "memoryEnabled (boolean) or templateId required" });
      const call = await c.calls.findOneAndUpdate({ _id: callId as never }, { $set: set }, { projection: { projectId: 1 } });
      if (call && templateId) await audit("template_assigned", str(b.actor) ?? "workspace", templateId, { templateId }, callId, typeof call.projectId === "string" ? call.projectId : config.projectId);
      return send(res, call ? 200 : 404, set);
    }
    if (req.method === "GET" && url.pathname === "/api/templates") {
      return send(res, 200, await c.agentTemplates.find({ teamId: config.teamId }).sort({ name: 1 }).toArray());
    }
    if (req.method === "POST" && url.pathname === "/api/templates") {
      const r = await saveTemplate(await body(req));
      return send(res, r.status, r.data);
    }
    const tplMatch = /^\/api\/templates\/([^/]+)$/.exec(url.pathname);
    if (req.method === "PUT" && tplMatch) {
      const r = await saveTemplate(await body(req), decodeURIComponent(tplMatch[1]));
      return send(res, r.status, r.data);
    }
    if (req.method === "GET" && url.pathname === "/api/says/stream") {
      const callId = url.searchParams.get("callId");
      if (!callId) return send(res, 400, { error: "callId required" });
      return streamSays(req, res, callId);
    }
    const ack = /^\/api\/says\/([^/]+)\/ack$/.exec(url.pathname);
    if (req.method === "POST" && ack) {
      const b = await body(req);
      const status = (["started", "done", "failed", "cancelled"] as const).find((s) => s === b.status);
      if (!status) return send(res, 400, { error: "status must be started|done|failed|cancelled" });
      const r = await c.says.updateOne({ sayId: decodeURIComponent(ack[1]) }, { $set: { status, updatedAt: new Date() } });
      return send(res, r.matchedCount ? 200 : 404, { status });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[http]", e);
    send(res, 500, { error: errText(e) });
  }
});

server.listen(config.port, () => console.log(`[http] gomon worker on :${config.port} (db ${config.dbName}, team ${config.teamId}, default project ${config.projectId})`));
// VOICE_OUT=recall: the worker speaks into meetings itself (ElevenLabs mp3 -> Recall output_audio); the bot page only relays webhooks.
if (process.env.VOICE_OUT === "recall") startRecallVoice(c, console.log);
setInterval(() => { sweepAllLocks().catch((e) => console.error("[locks]", e)); }, 1000);
setInterval(() => { catchUp().catch((e) => console.error("[catchup]", e)); }, 15_000);
// After a call ends, its lines are renamed to the people Recall heard (speakers.ts); live, the listener knows only "you" / "others".
setInterval(() => { sweepSpeakers(c).catch((e) => console.error("[speakers]", e instanceof Error ? e.message : e)); }, 20_000);
watchEndRequests();
await catchUp();
await watchUtterances();
