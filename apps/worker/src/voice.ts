/**
 * Voice out without a webpage: each queued `says` row for a call with a Recall bot is rendered by ElevenLabs (mp3) and played
 * into the meeting through Recall's Output Audio endpoint. Used when VOICE_OUT=recall (no public tunnel without a browser
 * warning page is needed for audio).
 * Floor (Max, Nov 14): `heard` plays a short chime the moment someone says the wake word, before any model call, and
 * `stopSpeaking` cuts the clip (Recall DELETE output_audio) when a person says "stop" or talks over Gomon (floor.ts).
 */
import { readFileSync } from "node:fs";
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
const sound = (name: string) => readFileSync(new URL(`../public/sounds/${name}.mp3`, import.meta.url));
/** Two rising tones, 0.36 s: "I heard my name, working on it". */
const CHIME = sound("heard");
const SILENCE = sound("silence");
/** True once startRecallVoice runs (VOICE_OUT=recall): this process is the one speaking into meetings. */
let voiceOn = false;
/** The line Gomon is saying right now, per call. `cut` ends the wait for the clip so the queue moves on. */
const speakingNow = new Map<string, { say: Say; cut: () => void }>();
/** When each call's floor was last taken back: lines created before that are never spoken. */
const cutAt = new Map<string, number>();
const wasCut = (s: Say) => (cutAt.get(s.callId) ?? 0) >= s.createdAt.getTime();

export const speakingText = (callId: string): string | null => speakingNow.get(callId)?.say.text ?? null;

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

/** Stop the clip that is playing. Recall's DELETE ends it; if that is refused, a silent clip replaces it. */
async function stopAudio(botId: string): Promise<void> {
  const res = await fetch(`https://${env.region()}.recall.ai/api/v1/bot/${botId}/output_audio/`, {
    method: "DELETE", headers: { authorization: `Token ${env.recallKey()}`, accept: "application/json" },
  });
  if (!res.ok) await playInMeeting(botId, SILENCE);
}

type Bot = { botId: string; teamId: string; projectId: string };
/** A call's bot does not change while it is in the meeting: remembered for 30 s, so the chime and each line skip one Atlas round trip (~100 ms). */
const bots = new Map<string, { at: number; bot: Bot }>();
const botOf = async (c: Cols, callId: string): Promise<Bot> => {
  const hit = bots.get(callId);
  if (hit && Date.now() - hit.at < 30_000) return hit.bot;
  const call = await c.calls.findOne({ _id: callId as never }, { projection: { botId: 1, teamId: 1, projectId: 1 } });
  const bot = { botId: typeof call?.botId === "string" ? call.botId : "", teamId: String(call?.teamId ?? ""), projectId: String(call?.projectId ?? "") };
  if (bot.botId) bots.set(callId, { at: Date.now(), bot });
  return bot;
};

/**
 * A person took the floor: cut the clip, drop this call's lines that were already waiting, and say why in agent_events.
 * Returns false when Gomon was not speaking. `why`: stop_word | talk_over | wake_word.
 */
export async function stopSpeaking(c: Cols, callId: string, why: string, heardText = ""): Promise<boolean> {
  const cur = speakingNow.get(callId);
  if (!cur) return false;
  speakingNow.delete(callId);
  cutAt.set(callId, Date.now());
  cur.cut();
  const { botId } = await botOf(c, callId);
  const now = new Date();
  await Promise.all([
    botId ? stopAudio(botId).catch((e) => console.error("[voice] stop failed:", e instanceof Error ? e.message : e)) : Promise.resolve(),
    c.says.updateMany({ callId, status: { $in: ["queued", "started"] }, createdAt: { $lte: now } }, { $set: { status: "cancelled", cancelledBy: why, updatedAt: now } }),
    c.agentEvents.insertOne({ callId, teamId: cur.say.teamId, projectId: cur.say.projectId, at: now, kind: "barge_in", why, heard: heardText.slice(0, 200), cut: cur.say.text }),
    c.calls.updateOne({ _id: callId as never }, { $set: { agentState: { state: "listening", detail: why === "wake_word" ? "stopped: new question" : "stopped: someone took the floor", at: now } } }),
  ]);
  void showCard(c, callId, "listening", { force: true });
  return true;
}

/**
 * Someone said the wake word: confirm it before any model call. Cuts an answer still playing (the new question wins), shows
 * Thinking, writes the state line the workspace shows, and plays the chime into the meeting. Timed as `wake_to_chime`.
 */
export async function heard(c: Cols, callId: string, who: string): Promise<void> {
  const t0 = Date.now();
  await stopSpeaking(c, callId, "wake_word");
  // The state line is written while the chime goes out, not before it (one Atlas round trip less before the sound).
  const state = c.calls
    .updateOne({ _id: callId as never }, { $set: { agentState: { state: "searching", detail: `heard ${who.split(" ")[0]}, checking team memory`, at: new Date() } } })
    .then(() => void showCard(c, callId, "thinking"));
  if (!voiceOn || process.env.HEARD_CHIME === "off") return void (await state);
  const { botId, teamId, projectId } = await botOf(c, callId);
  if (!botId) return void (await state);
  await Promise.all([playInMeeting(botId, CHIME), state]);
  await c.timings.insertOne({ callId, teamId, projectId, stage: "wake_to_chime", ms: Date.now() - t0, at: new Date() });
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
    const { botId } = await botOf(c, s.callId);
    if (!botId || wasCut(s)) return;
    if (UNPROMPTED.has(s.reason)) await floorFree(s.callId, s.createdAt);
    if (Date.now() - s.createdAt.getTime() > STALE_MS) {
      await c.says.updateOne({ sayId: s.sayId }, { $set: { status: "cancelled", updatedAt: new Date() } });
      return;
    }
    const t0 = Date.now();
    try {
      const mp3 = await ttsMp3(s.text, s.voiceId);
      // The floor was taken back while this line was waiting or rendering: it is already marked cancelled.
      if (wasCut(s)) return;
      void showCard(c, s.callId, "speaking", { forMs: spokenMs(s.text) });
      const { promise: cutOff, resolve: cut } = Promise.withResolvers<void>();
      speakingNow.set(s.callId, { say: s, cut });
      // The clip goes to the meeting while the row is marked started, not after it (~100 ms sooner).
      await Promise.all([playInMeeting(botId, mp3), c.says.updateOne({ sayId: s.sayId, status: "queued" }, { $set: { status: "started", updatedAt: new Date() } })]);
      await c.timings.insertOne({ callId: s.callId, teamId: s.teamId, projectId: s.projectId, stage: "say_to_audio", ms: Date.now() - t0, at: new Date() });
      log(`[voice] ${s.reason} -> meeting (${Date.now() - t0} ms): ${s.text.slice(0, 70)}`);
      // Until the clip ends, or until a person takes the floor (stopSpeaking resolves cutOff and marks the line cancelled).
      await Promise.race([new Promise((r) => setTimeout(r, spokenMs(s.text))), cutOff]);
      if (speakingNow.get(s.callId)?.say.sayId !== s.sayId) return;
      speakingNow.delete(s.callId);
      void showCard(c, s.callId, "listening", { force: true });
      await c.says.updateOne({ sayId: s.sayId, status: "started" }, { $set: { status: "done", updatedAt: new Date() } });
    } catch (e) {
      log("[voice] failed:", e instanceof Error ? e.message : e);
      if (speakingNow.get(s.callId)?.say.sayId === s.sayId) speakingNow.delete(s.callId);
      await c.says.updateOne({ sayId: s.sayId }, { $set: { status: "failed", updatedAt: new Date() } });
    }
  };
  const cs = c.says.watch([{ $match: { operationType: "insert" } }]);
  cs.on("change", (ev) => {
    const s = (ev as ChangeStreamInsertDocument<Say>).fullDocument;
    const prev = queues.get(s.callId) ?? Promise.resolve();
    queues.set(s.callId, prev.then(() => speak(s)));
  });
  voiceOn = true;
  void ttsMp3("On it.").catch(() => {}); // warm the cache for the instant acknowledgment
  log(`[voice] speaking through Recall output_audio (model ${env.model()})`);
  return () => cs.close();
}
