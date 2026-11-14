/**
 * Gomon worker.
 *   POST /api/utterances          committed transcript segment in (Recall webhook relay, bot page, or typed)
 *   POST /api/calls               create/ensure a call            PATCH /api/calls/:id  { memoryEnabled }  (A/B memory proof)
 *   GET  /api/says/stream?callId= SSE of Gomon's speech for the bot page     POST /api/says/:sayId/ack { status }
 * Utterance inserts wake the agent through an Atlas change stream (resume token in stream_offsets); a sweep catches anything
 * missed, and a timer promotes consensus locks after their veto window.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { MongoServerError, type ObjectId, type ResumeToken } from "mongodb";
import { config } from "./config.ts";
import { cols, connect } from "./db.ts";
import { handleBatch, sweepLocks, type Stored } from "./agent.ts";
import { checkPolicy, type Ctx } from "./governance.ts";
import type { AgentTemplate, Say, Utterance } from "./shapes.ts";
import { DEFAULT_TEMPLATE_ID, parseTemplateInput } from "./templates.ts";
import { parseWake } from "./wake.ts";
import { login, logout, userFromToken, userIdForDisplayName, visibleCallsFilter } from "./auth.ts";

const { client, db } = await connect();
const c = cols(db);
const ctx: Ctx = { client, c, teamId: config.teamId, projectId: config.projectId };
const STREAM_ID = `worker-utterances:${config.teamId}:${config.projectId}`;
/** Identifies this process on claimed utterances, so a second worker on the same database is visible. */
const WORKER_ID = `${hostname()}:${process.pid}`;

// ---------- processing: one batch at a time per call; everything that arrived meanwhile is the next batch ----------
const MAX_BATCH = 8;
const MERGE_QUIET_MS = Number(process.env.MERGE_QUIET_MS || 1200);
const MERGE_MAX_MS = Number(process.env.MERGE_MAX_MS || 3500);
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
  const pendingFilter = { callId, processedAt: { $exists: false }, claimedAt: { $exists: false } };
  for (;;) {
    const pending = await c.utterances.find(pendingFilter, { projection: { text: 1, receivedAt: 1 } }).sort({ seq: 1 }).limit(MAX_BATCH).toArray();
    if (!pending.length) return false;
    if (pending.length >= MAX_BATCH || pending.some((p) => parseWake(p.text).addressed)) break;
    const now = Date.now();
    const quietFor = now - pending[pending.length - 1].receivedAt.getTime();
    const waited = now - pending[0].receivedAt.getTime();
    if (quietFor >= MERGE_QUIET_MS || waited >= MERGE_MAX_MS) break;
    await sleep(Math.min(MERGE_QUIET_MS - quietFor, MERGE_MAX_MS - waited) + 20);
  }
  const ids = (await c.utterances.find(pendingFilter, { projection: { _id: 1 } }).sort({ seq: 1 }).limit(MAX_BATCH).toArray()).map((d) => d._id);
  if (!ids.length) return false;
  const claimToken = randomUUID();
  await c.utterances.updateMany({ _id: { $in: ids }, processedAt: { $exists: false }, claimedAt: { $exists: false } }, { $set: { claimedAt: new Date(), claimToken, claimedBy: WORKER_ID } });
  const batch = (await c.utterances.find({ claimToken }).sort({ seq: 1 }).toArray()) as Stored[];
  if (!batch.length) return true;
  try {
    await handleBatch(ctx, batch);
    await c.utterances.updateMany({ claimToken }, { $set: { processedAt: new Date() } });
  } catch (e) {
    console.error(`[agent] batch of ${batch.length} in ${callId} failed:`, e);
    await c.utterances.updateMany({ claimToken }, { $set: { processedAt: new Date(), error: String(e instanceof Error ? e.message : e) } });
  }
  return true;
}

async function catchUp(): Promise<void> {
  const stale = new Date(Date.now() - 120_000);
  await c.utterances.updateMany(
    { teamId: config.teamId, projectId: config.projectId, processedAt: { $exists: false }, claimedAt: { $lt: stale } },
    { $unset: { claimedAt: "", claimToken: "" } },
  );
  const calls = await c.utterances.distinct("callId", { teamId: config.teamId, projectId: config.projectId, processedAt: { $exists: false } });
  for (const callId of calls) schedule(callId);
}

async function watchUtterances(): Promise<void> {
  const saved = await c.streamOffsets.findOne({ _id: STREAM_ID });
  const pipeline = [{ $match: { operationType: "insert", "fullDocument.teamId": config.teamId, "fullDocument.projectId": config.projectId } }];
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

async function ensureCall(callId: string, opts: { title?: string; speaker?: string; meetingUrl?: string; templateId?: string; botId?: string; ownerUserId?: string } = {}): Promise<number> {
  const { title, speaker, meetingUrl, templateId, botId, ownerUserId } = opts;
  const speakerUserId = speaker ? await userIdForDisplayName(c, config.teamId, speaker) : null;
  const addToSet: Record<string, string> = {};
  if (speaker) addToSet.participants = speaker;
  if (speakerUserId) addToSet.participantUserIds = speakerUserId;
  const call = await c.calls.findOneAndUpdate(
    { _id: callId as never },
    {
      $inc: { utteranceSeq: speaker ? 1 : 0 },
      $setOnInsert: {
        teamId: config.teamId, projectId: config.projectId, title: title ?? "Design call", status: "live", startedAt: new Date(), memoryEnabled: true,
        templateId: templateId ?? DEFAULT_TEMPLATE_ID, ...(meetingUrl ? { meetingUrl } : {}), ...(ownerUserId ? { ownerUserId } : {}),
      },
      ...(botId ? { $set: { botId } } : {}),
      ...(Object.keys(addToSet).length ? { $addToSet: addToSet } : {}),
    },
    { upsert: true, returnDocument: "after" },
  );
  return Number(call?.utteranceSeq ?? 0);
}

async function postUtterance(b: Record<string, unknown>) {
  const callId = str(b.callId), text = str(b.text);
  const speakerName = str((b.speaker as Record<string, unknown> | undefined)?.displayName) ?? str(b.speaker);
  if (!callId || !text || !speakerName) return { status: 400, data: { error: "callId, text and speaker.displayName are required" } };
  const source = (["recall", "scribe", "typed"] as const).find((s) => s === b.source) ?? "typed";
  const sourceKey = str(b.sourceKey) ?? randomUUID();
  // Recall sourceKeys are recall:<botId>:<participantId>:<start>; the bot id lets Gomon post to the meeting chat.
  const botId = /^recall:([^:]+):/.exec(sourceKey)?.[1];
  const seq = await ensureCall(callId, { speaker: speakerName, botId });
  const doc: Utterance = {
    callId, teamId: config.teamId, projectId: config.projectId, seq, sourceKey,
    speaker: { displayName: speakerName }, text, source, receivedAt: new Date(),
    ...(str(b.startedAt) ? { startedAt: new Date(String(b.startedAt)) } : {}), ...(str(b.endedAt) ? { endedAt: new Date(String(b.endedAt)) } : {}),
  };
  try {
    const r = await c.utterances.insertOne(doc);
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

async function audit(type: string, actor: string, reason: string, ref: Record<string, unknown>, callId?: string): Promise<void> {
  await c.auditEvents.insertOne({ teamId: config.teamId, projectId: config.projectId, at: new Date(), type, actor, reason, ref, ...(callId ? { callId } : {}) });
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
      const calls = await c.calls.find(visibleCallsFilter(me), { projection: { title: 1, status: 1, startedAt: 1, participants: 1, ownerUserId: 1, templateId: 1, agentState: 1 } })
        .sort({ startedAt: -1 }).limit(100).toArray();
      return send(res, 200, calls);
    }
    if (req.method === "POST" && url.pathname === "/api/calls") {
      const b = await body(req);
      const templateId = str(b.templateId);
      if (templateId && !(await c.agentTemplates.findOne({ _id: templateId, teamId: config.teamId }))) return send(res, 400, { error: `unknown template ${templateId}` });
      const callId = str(b.callId) ?? `call-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 4)}`;
      await ensureCall(callId, { title: str(b.title), meetingUrl: str(b.meetingUrl), templateId, ownerUserId: me?._id });
      return send(res, 201, { callId, templateId: templateId ?? DEFAULT_TEMPLATE_ID, ownerUserId: me?._id ?? null });
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
      const r = await c.calls.updateOne({ _id: callId as never }, { $set: set });
      if (r.matchedCount && templateId) await audit("template_assigned", str(b.actor) ?? "workspace", templateId, { templateId }, callId);
      return send(res, r.matchedCount ? 200 : 404, set);
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
    send(res, 500, { error: String(e instanceof Error ? e.message : e) });
  }
});

server.listen(config.port, () => console.log(`[http] gomon worker on :${config.port} (db ${config.dbName}, ${config.teamId}/${config.projectId})`));
setInterval(() => { sweepLocks(ctx).catch((e) => console.error("[locks]", e)); }, 1000);
setInterval(() => { catchUp().catch((e) => console.error("[catchup]", e)); }, 15_000);
await catchUp();
await watchUtterances();
