/**
 * Recall.ai bot dispatch for POST /api/meetings. The request is the one apps/bot-page/scripts/create-bot.js sends (fields
 * verified against docs.recall.ai): transcripts stream to the bot page's webhook for this callId, and the bot page itself
 * is the bot's camera, so it can speak Gomon's lines.
 */
import { config } from "./config.ts";

export type RecallConfig = typeof config.recall;

/** Create Bot body. Pure, so it can be inspected without dispatching a bot. */
export function botRequestBody(meetingUrl: string, callId: string, rc: RecallConfig = config.recall): Record<string, unknown> {
  if (!/^https:\/\//.test(rc.publicBaseUrl)) throw new Error("PUBLIC_BASE_URL must be the bot page's public https URL (tunnel)");
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

/** Send a Gomon bot into the meeting; returns Recall's bot id. */
export async function createBot(meetingUrl: string, callId: string, rc: RecallConfig = config.recall): Promise<string> {
  const bot = await recall("bot/", { method: "POST", body: botRequestBody(meetingUrl, callId, rc) }, rc);
  if (typeof bot.id !== "string") throw new Error("Recall returned no bot id");
  return bot.id;
}

/** Take the bot out of its meeting (apps/bot-page/scripts/leave-bot.js). */
export async function leaveBot(botId: string, rc: RecallConfig = config.recall): Promise<void> {
  await recall(`bot/${encodeURIComponent(botId)}/leave_call/`, { method: "POST" }, rc);
}
