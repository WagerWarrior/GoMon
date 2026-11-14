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
import { MongoServerError, type ObjectId, type ResumeToken } from "mongodb";
import { config } from "./config.ts";
import { cols, connect } from "./db.ts";
import { handleBatch, sweepLocks, type Stored } from "./agent.ts";
import type { Ctx } from "./governance.ts";
import type { Say, Utterance } from "./shapes.ts";

const { client, db } = await connect();
const c = cols(db);
const ctx: Ctx = { client, c, teamId: config.teamId, projectId: config.projectId };
const STREAM_ID = `worker-utterances:${config.teamId}:${config.projectId}`;

// ---------- processing: one batch at a time per call; everything that arrived meanwhile is the next batch ----------
const MAX_BATCH = 8;
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

/** Claim this call's unprocessed utterances (atomically, by token) and handle them as one batch. Returns false when none. */
async function processPending(callId: string): Promise<boolean> {
  const ids = (await c.utterances.find({ callId, processedAt: { $exists: false }, claimedAt: { $exists: false } }, { projection: { _id: 1 } })
    .sort({ seq: 1 }).limit(MAX_BATCH).toArray()).map((d) => d._id);
  if (!ids.length) return false;
  const claimToken = randomUUID();
  await c.utterances.updateMany({ _id: { $in: ids }, processedAt: { $exists: false }, claimedAt: { $exists: false } }, { $set: { claimedAt: new Date(), claimToken } });
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

async function ensureCall(callId: string, title?: string, speaker?: string, meetingUrl?: string): Promise<number> {
  const call = await c.calls.findOneAndUpdate(
    { _id: callId as never },
    {
      $inc: { utteranceSeq: speaker ? 1 : 0 },
      $setOnInsert: { teamId: config.teamId, projectId: config.projectId, title: title ?? "Design call", status: "live", startedAt: new Date(), memoryEnabled: true, ...(meetingUrl ? { meetingUrl } : {}) },
      ...(speaker ? { $addToSet: { participants: speaker } } : {}),
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
  const seq = await ensureCall(callId, undefined, speakerName);
  const doc: Utterance = {
    callId, teamId: config.teamId, projectId: config.projectId, seq, sourceKey: str(b.sourceKey) ?? randomUUID(),
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
  const emit = (s: Say) => res.write(`event: say\ndata: ${JSON.stringify({ sayId: s.sayId, text: s.text, priority: s.priority, reason: s.reason, createdAt: s.createdAt })}\n\n`);
  void c.says.find({ callId, status: "queued" }).sort({ createdAt: 1 }).forEach((s) => { emit(s); });
  const cs = c.says.watch([{ $match: { operationType: "insert", "fullDocument.callId": callId } }]);
  cs.on("change", (ev) => { if (ev.operationType === "insert") emit(ev.fullDocument); });
  const ka = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  req.on("close", () => { clearInterval(ka); void cs.close(); });
}

const server = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
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
    if (req.method === "POST" && url.pathname === "/api/calls") {
      const b = await body(req);
      const callId = str(b.callId) ?? `call-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 4)}`;
      await ensureCall(callId, str(b.title), undefined, str(b.meetingUrl));
      return send(res, 201, { callId });
    }
    const callMatch = /^\/api\/calls\/([^/]+)$/.exec(url.pathname);
    if (req.method === "PATCH" && callMatch) {
      const b = await body(req);
      if (typeof b.memoryEnabled !== "boolean") return send(res, 400, { error: "memoryEnabled boolean required" });
      const r = await c.calls.updateOne({ _id: decodeURIComponent(callMatch[1]) as never }, { $set: { memoryEnabled: b.memoryEnabled } });
      return send(res, r.matchedCount ? 200 : 404, { memoryEnabled: b.memoryEnabled });
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
