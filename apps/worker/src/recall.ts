/**
 * Recall.ai bot dispatch for POST /api/meetings (and `npm run join`). Two modes:
 *  - no PUBLIC_BASE_URL (default, no tunnel): the bot only speaks (Output Audio) and shows Gomon's state card (Output Video);
 *    ears are the local Scribe page (http://localhost:3001/ears), which finds the live call by itself.
 *  - PUBLIC_BASE_URL set: transcripts stream to the bot page's webhook and the bot page is the bot's camera (needs a tunnel
 *    without a browser warning page).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { cardB64 } from "./card.ts";
import { ttsMp3 } from "./voice.ts";

export type RecallConfig = typeof config.recall;
export type BotMedia = { greetingMp3B64: string; cardJpegB64: string };

export const GREETING = "Hey, Gomon here. I'll keep track of decisions. Say hey Gomon if you need me.";

/** Create Bot body. Pure, so it can be inspected without dispatching a bot. */
export function botRequestBody(meetingUrl: string, callId: string, rc: RecallConfig = config.recall, media?: BotMedia): Record<string, unknown> {
  if (!/^https:\/\//.test(rc.publicBaseUrl)) {
    if (!media) throw new Error("no PUBLIC_BASE_URL: pass the greeting and card (no-tunnel mode)");
    const card = { kind: "jpeg", b64_data: media.cardJpegB64 };
    // Who is in the call: Recall posts join/leave events to the events tunnel (roster.ts), when one is up.
    const events = /^https:\/\//.test(rc.eventsUrl) && rc.webhookToken ? new URL(`${rc.eventsUrl.replace(/\/$/, "")}/recall/events/`) : null;
    events?.searchParams.set("callId", callId);
    events?.searchParams.set("token", rc.webhookToken);
    return {
      meeting_url: meetingUrl,
      bot_name: "Gomon",
      metadata: { callId },
      ...(events ? { recording_config: { realtime_endpoints: [{ type: "webhook", url: events.toString(), events: ["participant_events.join", "participant_events.leave"] }] } } : {}),
      // Output Audio needs automatic_audio_output configured; the greeting doubles as it.
      automatic_audio_output: { in_call_recording: { data: { kind: "mp3", b64_data: media.greetingMp3B64 } } },
      automatic_video_output: { in_call_recording: card, in_call_not_recording: card },
    };
  }
  const base = rc.publicBaseUrl.replace(/\/$/, "");
  // Recall requires a "/" before the query string, otherwise deliveries fail with HTTP 400.
  const webhook = new URL(`${base}/recall/webhook/`);
  webhook.searchParams.set("callId", callId);
  // Signature verification (workspace secret) is Recall's recommended auth; the query token is the fallback.
  if (!rc.webhookSecret && rc.webhookToken) webhook.searchParams.set("token", rc.webhookToken);
  return {
    meeting_url: meetingUrl,
    bot_name: "Gomon",
    metadata: { callId },
    recording_config: {
      transcript: { provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } } },
      realtime_endpoints: [{ type: "webhook", url: webhook.toString(), events: ["transcript.data"] }],
    },
    // Output Media runs the bot page in the bot's browser; web_4_core avoids choppy audio/video (docs recommend it).
    variant: { google_meet: rc.botVariant, zoom: rc.botVariant, microsoft_teams: rc.botVariant },
    output_media: { camera: { kind: "webpage", config: { url: `${base}/?callId=${encodeURIComponent(callId)}` } } },
  };
}

async function recall(path: string, init: { method: "POST"; body?: unknown }, rc: RecallConfig): Promise<Record<string, unknown>> {
  if (!rc.apiKey) throw new Error("RECALL_API_KEY is not set");
  const r = await fetch(`https://${rc.region}.recall.ai/api/v1/${path}`, {
    method: init.method,
    headers: { authorization: `Token ${rc.apiKey}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Recall ${r.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** The events tunnel's URL, written by `npm run tunnel` while it runs (read per bot: each tunnel run has a new URL). */
export const TUNNEL_FILE = fileURLToPath(new URL("../../../.local/tunnel-url", import.meta.url));
function tunnelUrl(): string {
  try { return readFileSync(TUNNEL_FILE, "utf8").trim(); } catch { return ""; }
}

/** Send a Gomon bot into the meeting; returns Recall's bot id. */
export async function createBot(meetingUrl: string, callId: string, rc: RecallConfig = config.recall): Promise<string> {
  const media = /^https:\/\//.test(rc.publicBaseUrl)
    ? undefined
    : { greetingMp3B64: (await ttsMp3(GREETING)).toString("base64"), cardJpegB64: cardB64("listening") };
  const eventsUrl = rc.eventsUrl || tunnelUrl();
  let bot: Record<string, unknown>;
  try {
    bot = await recall("bot/", { method: "POST", body: botRequestBody(meetingUrl, callId, { ...rc, eventsUrl }, media) }, rc);
  } catch (e) {
    // Joining matters more than the live roster: if Recall refuses the request with the events endpoint, send it without.
    if (!eventsUrl || !/^Recall 4\d\d/.test(e instanceof Error ? e.message : "")) throw e;
    console.error(`[recall] bot with join/leave events refused (${e instanceof Error ? e.message : e}); sending it without them`);
    bot = await recall("bot/", { method: "POST", body: botRequestBody(meetingUrl, callId, { ...rc, eventsUrl: "" }, media) }, rc);
  }
  if (typeof bot.id !== "string") throw new Error("Recall returned no bot id");
  return bot.id;
}

/** Take the bot out of its meeting (apps/bot-page/scripts/leave-bot.js). */
export async function leaveBot(botId: string, rc: RecallConfig = config.recall): Promise<void> {
  await recall(`bot/${encodeURIComponent(botId)}/leave_call/`, { method: "POST" }, rc);
}
