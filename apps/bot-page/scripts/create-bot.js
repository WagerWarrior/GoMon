// Send a Gomon bot into a meeting via Recall.ai Create Bot.
// Usage: npm run create-bot -- <meeting_url> [callId]
// Fields verified against docs.recall.ai on 2026-11-14 (bot_create, stream-media, bot-real-time-transcription).
import { randomUUID } from "node:crypto";

const [meetingUrl, callIdArg] = process.argv.slice(2);
const { RECALL_API_KEY, RECALL_REGION = "us-west-2", PUBLIC_BASE_URL, RECALL_WEBHOOK_TOKEN = "", RECALL_WEBHOOK_SECRET = "",
  RECALL_BOT_VARIANT = "web_4_core" } = process.env;

if (!meetingUrl) { console.error("usage: npm run create-bot -- <meeting_url> [callId]"); process.exit(1); }
for (const [k, v] of Object.entries({ RECALL_API_KEY, PUBLIC_BASE_URL })) {
  if (!v) { console.error(`${k} is not set in .env`); process.exit(1); }
}

if (!/^https:\/\//.test(PUBLIC_BASE_URL)) { console.error("PUBLIC_BASE_URL must be a public https URL (tunnel)"); process.exit(1); }

const callId = callIdArg || `call-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${randomUUID().slice(0, 4)}`;
const base = PUBLIC_BASE_URL.replace(/\/$/, "");
// Recall requires a "/" before the query string, otherwise deliveries fail with HTTP 400.
const webhook = new URL(`${base}/recall/webhook/`);
webhook.searchParams.set("callId", callId);
// Signature verification (workspace secret) is Recall's recommended auth; the query token is the fallback.
if (!RECALL_WEBHOOK_SECRET && RECALL_WEBHOOK_TOKEN) webhook.searchParams.set("token", RECALL_WEBHOOK_TOKEN);

const body = {
  meeting_url: meetingUrl,
  bot_name: "Gomon",
  metadata: { callId },
  recording_config: {
    transcript: { provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } } },
    realtime_endpoints: [{ type: "webhook", url: webhook.toString(), events: ["transcript.data"] }],
  },
  // Output Media runs our page in the bot's browser; web_4_core avoids choppy audio/video (docs recommend it).
  variant: { google_meet: RECALL_BOT_VARIANT, zoom: RECALL_BOT_VARIANT, microsoft_teams: RECALL_BOT_VARIANT },
  output_media: { camera: { kind: "webpage", config: { url: `${base}/?callId=${encodeURIComponent(callId)}` } } },
};

const r = await fetch(`https://${RECALL_REGION}.recall.ai/api/v1/bot/`, {
  method: "POST",
  headers: { authorization: `Token ${RECALL_API_KEY}`, "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(body),
});
const text = await r.text();
if (!r.ok) { console.error(`Recall ${r.status}: ${text}`); process.exit(1); }
const bot = JSON.parse(text);
console.log(JSON.stringify({ callId, botId: bot.id, meetingUrl }, null, 2));
console.log("Admit 'Gomon' in the Meet when it asks to join.");
