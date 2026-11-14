/**
 * Voice out without a webpage: each queued `says` row for a call with a Recall bot is rendered by ElevenLabs (mp3) and played
 * into the meeting through Recall's Output Audio endpoint. Used when VOICE_OUT=recall (no public tunnel without a browser
 * warning page is needed for audio). Tradeoff: a clip cannot be cut off mid-line, so barge-in needs the camera-page path.
 */
import type { ChangeStreamInsertDocument } from "mongodb";
import type { Cols } from "./db.ts";
import type { Say } from "./shapes.ts";
import { showCard } from "./card.ts";

const env = {
  elKey: () => process.env.ELEVENLABS_API_KEY ?? "",
  voice: () => process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb",
  // Flash renders a line in ~0.5 s vs ~1.5 s for eleven_v4_turbo (more expressive); Recall needs the whole clip before playing.
  model: () => process.env.VOICE_MODEL || "eleven_flash_v2_5",
  recallKey: () => process.env.RECALL_API_KEY ?? "",
  region: () => process.env.RECALL_REGION || "us-west-2",
};
/** Lines older than this when their turn comes are dropped: the room has moved on. */
const STALE_MS = 20_000;
/** Unprompted lines (conflicts) wait until nobody has finished a sentence for this long. */
const FLOOR_QUIET_MS = 1500;
const UNPROMPTED: ReadonlySet<Say["reason"]> = new Set(["conflict", "already_decided", "suggestion"]);
const cache = new Map<string, Buffer>();

export async function ttsMp3(text: string, voiceId?: string): Promise<Buffer> {
  const voice = voiceId || env.voice();
  const key = `${voice}|${env.model()}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": env.elKey(), "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: env.model() }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const mp3 = Buffer.from(await res.arrayBuffer());
  if (text.length <= 40) cache.set(key, mp3); // short stock lines ("On it.") are reused
  return mp3;
}

export async function playInMeeting(botId: string, mp3: Buffer): Promise<void> {
  const res = await fetch(`https://${env.region()}.recall.ai/api/v1/bot/${botId}/output_audio/`, {
    method: "POST",
    headers: { authorization: `Token ${env.recallKey()}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ kind: "mp3", b64_data: mp3.toString("base64") }),
  });
  if (!res.ok) throw new Error(`Recall output_audio ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Rough spoken duration so consecutive clips don't overlap (Recall plays each clip as it arrives). */
const spokenMs = (text: string) => Math.max(1200, Math.round(text.split(/\s+/).length * 330));

/** Watches `says` inserts and speaks them per call, in order. Returns a stop function. */
export function startRecallVoice(c: Cols, log: (...a: unknown[]) => void): () => Promise<void> {
  const queues = new Map<string, Promise<void>>();
  // Waits for a pause; gives up at the staleness limit (the caller then drops the line).
  const floorFree = async (callId: string, createdAt: Date) => {
    while (Date.now() - createdAt.getTime() < STALE_MS) {
      const last = await c.utterances.find({ callId }).sort({ receivedAt: -1 }).limit(1).project({ receivedAt: 1 }).next();
      const at = last?.receivedAt instanceof Date ? last.receivedAt.getTime() : 0;
      if (Date.now() - at >= FLOOR_QUIET_MS) return;
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  const speak = async (s: Say) => {
    const call = await c.calls.findOne({ _id: s.callId as never }, { projection: { botId: 1 } });
    const botId = typeof call?.botId === "string" ? call.botId : "";
    if (!botId) return;
    if (UNPROMPTED.has(s.reason)) await floorFree(s.callId, s.createdAt);
    if (Date.now() - s.createdAt.getTime() > STALE_MS) {
      await c.says.updateOne({ sayId: s.sayId }, { $set: { status: "cancelled", updatedAt: new Date() } });
      return;
    }
    const t0 = Date.now();
    try {
      const mp3 = await ttsMp3(s.text, s.voiceId);
      await c.says.updateOne({ sayId: s.sayId }, { $set: { status: "started", updatedAt: new Date() } });
      void showCard(c, s.callId, "speaking", { forMs: spokenMs(s.text) });
      await playInMeeting(botId, mp3);
      await c.timings.insertOne({ callId: s.callId, teamId: s.teamId, projectId: s.projectId, stage: "say_to_audio", ms: Date.now() - t0, at: new Date() });
      log(`[voice] ${s.reason} -> meeting (${Date.now() - t0} ms): ${s.text.slice(0, 70)}`);
      await new Promise((r) => setTimeout(r, spokenMs(s.text)));
      void showCard(c, s.callId, "listening", { force: true });
      await c.says.updateOne({ sayId: s.sayId }, { $set: { status: "done", updatedAt: new Date() } });
    } catch (e) {
      log("[voice] failed:", e instanceof Error ? e.message : e);
      await c.says.updateOne({ sayId: s.sayId }, { $set: { status: "failed", updatedAt: new Date() } });
    }
  };
  const cs = c.says.watch([{ $match: { operationType: "insert" } }]);
  cs.on("change", (ev) => {
    const s = (ev as ChangeStreamInsertDocument<Say>).fullDocument;
    const prev = queues.get(s.callId) ?? Promise.resolve();
    queues.set(s.callId, prev.then(() => speak(s)));
  });
  void ttsMp3("On it.").catch(() => {}); // warm the cache for the instant acknowledgment
  log(`[voice] speaking through Recall output_audio (model ${env.model()})`);
  return () => cs.close();
}
