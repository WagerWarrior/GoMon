/**
 * Gomon's ears without a public URL: a page on the laptop that is in the meeting captures the meeting tab's audio and the mic,
 * transcribes both with ElevenLabs Scribe realtime (outbound WebSocket), and posts committed segments here. Recall still joins
 * for voice and chat (outbound API calls), so no inbound webhook or tunnel is needed.
 *   GET  /ears              the capture page (public/ears.html)
 *   GET  /ears/token        single-use Scribe token (the API key never reaches the browser)
 *   POST /ears/utterance    { callId, speaker, text, channel: "meeting" | "mic" } -> utterance (source "scribe")
 *   POST /ears/partial      { callId, text, ms } words a person is saying right now: only used to stop Gomon (barge-in), never stored
 * Loopback only: these routes skip WORKER_TOKEN because they never leave the machine.
 */
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Cols } from "./db.ts";
import { config } from "./config.ts";
import { bargeIn } from "./floor.ts";
import { keyterms } from "./people.ts";
import { speakingText, stopSpeaking } from "./voice.ts";

type PostUtterance = (b: Record<string, unknown>) => Promise<{ status: number; data: unknown }>;

const PAGE = new URL("../public/ears.html", import.meta.url);
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** Gomon's own voice comes back through the meeting audio: drop segments that mostly repeat a line it said in this window. */
const ECHO_WINDOW_MS = 30_000;
const ECHO_OVERLAP = 0.6;
/** Without headphones the mic also hears the meeting: the same sentence arrives on both channels within a few seconds. */
const DUP_WINDOW_MS = 4_000;
const DUP_OVERLAP = 0.8;

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);

async function isEcho(c: Cols, callId: string, text: string): Promise<boolean> {
  const u = words(text);
  if (!u.length) return true;
  const recent = await c.says.find({ callId, createdAt: { $gte: new Date(Date.now() - ECHO_WINDOW_MS) } }).project({ text: 1, status: 1 }).toArray();
  for (const s of recent) {
    const said = new Set(words(String(s.text)));
    const overlap = u.filter((w) => said.has(w)).length / u.length;
    if (overlap >= ECHO_OVERLAP) return true;
    if (s.status === "started" && u.length < 3) return true; // fragments heard while Gomon is talking
  }
  return false;
}

async function isDuplicate(c: Cols, callId: string, text: string): Promise<boolean> {
  const u = new Set(words(text));
  if (!u.size) return false;
  const recent = await c.utterances.find({ callId, source: "scribe", receivedAt: { $gte: new Date(Date.now() - DUP_WINDOW_MS) } }).project({ text: 1 }).toArray();
  return recent.some((r) => {
    const o = new Set(words(String(r.text)));
    const shared = [...u].filter((w) => o.has(w)).length;
    return shared / u.size >= DUP_OVERLAP && shared / Math.max(1, o.size) >= DUP_OVERLAP;
  });
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  const parsed: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

/** Returns true when the request was an /ears route (handled or rejected). */
export async function handleEars(req: IncomingMessage, res: ServerResponse, url: URL, c: Cols, postUtterance: PostUtterance, startMeeting: PostUtterance): Promise<boolean> {
  if (url.pathname !== "/ears" && !url.pathname.startsWith("/ears/")) return false;
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) { send(res, 403, { error: "ears is local-only" }); return true; }
  if (req.method === "GET" && url.pathname === "/ears") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(await readFile(PAGE));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/ears/token") {
    const r = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", { method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" } });
    const body = (await r.json()) as { token?: string; detail?: unknown };
    // The team's names ride along, so Scribe spells people, logins and projects right (people.ts keyterms).
    const terms = await keyterms({ c, teamId: config.teamId }).catch(() => ["Gomon"]);
    send(res, r.ok && body.token ? 200 : 502, r.ok && body.token ? { token: body.token, keyterms: terms } : { error: "token failed", detail: body.detail });
    return true;
  }
  // The call to listen for: the latest live call that has a Gomon bot (so nobody types a call id).
  if (req.method === "GET" && url.pathname === "/ears/active") {
    const call = await c.calls.find({ teamId: config.teamId, status: "live", botId: { $type: "string" } }).sort({ startedAt: -1 }).limit(1).project({ title: 1, projectId: 1, meetingUrl: 1 }).next();
    send(res, call ? 200 : 404, call ? { callId: String(call._id), title: call.title, projectId: call.projectId, meetingUrl: call.meetingUrl } : { error: "no live call with Gomon" });
    return true;
  }
  // One step: paste the Meet link here, Gomon joins (same policy-checked path as the dashboard's Start meeting).
  if (req.method === "POST" && url.pathname === "/ears/join") {
    const r = await startMeeting(await json(req));
    send(res, r.status, r.data);
    return true;
  }
  if (req.method === "POST" && (url.pathname === "/ears/utterance" || url.pathname === "/ears/partial")) {
    const b = await json(req);
    const raw = typeof b.callId === "string" ? b.callId.trim() : "";
    // A Meet link pasted as the call id means "the call Gomon joined for that meeting" (latest one with that meetingUrl).
    const byUrl = /^https?:\/\//.test(raw)
      ? await c.calls.find({ meetingUrl: raw.replace(/\?.*$/, "") }).sort({ startedAt: -1 }).limit(1).project({ _id: 1 }).next()
      : null;
    const callId = byUrl ? String(byUrl._id) : raw;
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!callId || !text) { send(res, 400, { error: "callId and text required" }); return true; }
    // Barge-in first (the echo guard below would drop a bare "Stop." heard while Gomon talks): "stop", 5+ words over it,
    // or 1.2 s of talking cuts the clip. Partials are used for this and nothing else.
    const barge = bargeIn(text, speakingText(callId), Number(b.ms) || 0);
    if (barge) await stopSpeaking(c, callId, barge, text);
    if (url.pathname === "/ears/partial") { send(res, 200, { stopped: barge }); return true; }
    if (await isEcho(c, callId, text)) {
      await c.agentEvents.insertOne({ callId, teamId: config.teamId, projectId: config.projectId, at: new Date(), kind: "echo_dropped", text, channel: b.channel });
      send(res, 200, { dropped: "echo" });
      return true;
    }
    if (await isDuplicate(c, callId, text)) { send(res, 200, { dropped: "duplicate" }); return true; }
    const r = await postUtterance({ callId, text, speaker: { displayName: b.speaker }, source: "scribe", sourceKey: `scribe:${String(b.channel ?? "mic")}:${randomUUID()}` });
    send(res, r.status, r.data);
    return true;
  }
  send(res, 404, { error: "not found" });
  return true;
}
