/**
 * Send Gomon into a meeting with voice through Recall Output Audio (no camera webpage, so no tunnel browser-warning page).
 *   npm run join -- <meeting_url> [callId] [title]
 * Needs: RECALL_API_KEY, PUBLIC_BASE_URL (tunnel to apps/bot-page, which relays Recall transcript webhooks to this worker),
 * RECALL_WEBHOOK_SECRET or RECALL_WEBHOOK_TOKEN, ELEVENLABS_API_KEY. Run the worker with VOICE_OUT=recall.
 */
import { randomUUID } from "node:crypto";
import { config } from "../src/config.ts";
import { close, cols, connect } from "../src/db.ts";
import { DEFAULT_TEMPLATE_ID } from "../src/templates.ts";
import { ttsMp3 } from "../src/voice.ts";

const [meetingUrl, callIdArg, titleArg] = process.argv.slice(2);
const { RECALL_API_KEY, RECALL_REGION = "us-west-2", PUBLIC_BASE_URL = "", RECALL_WEBHOOK_TOKEN = "", RECALL_WEBHOOK_SECRET = "" } = process.env;
if (!meetingUrl || !RECALL_API_KEY || !/^https:\/\//.test(PUBLIC_BASE_URL)) {
  console.error("usage: npm run join -- <meeting_url> [callId] [title]   (needs RECALL_API_KEY and an https PUBLIC_BASE_URL)");
  process.exit(1);
}
const callId = callIdArg || `call-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${randomUUID().slice(0, 4)}`;
const webhook = new URL(`${PUBLIC_BASE_URL.replace(/\/$/, "")}/recall/webhook/`);
webhook.searchParams.set("callId", callId);
if (!RECALL_WEBHOOK_SECRET && RECALL_WEBHOOK_TOKEN) webhook.searchParams.set("token", RECALL_WEBHOOK_TOKEN);

// Output Audio requires automatic_audio_output; use it as Gomon's greeting.
const greeting = await ttsMp3("Hey, Gomon here. I'll keep track of decisions. Say hey Gomon if you need me.");
const res = await fetch(`https://${RECALL_REGION}.recall.ai/api/v1/bot/`, {
  method: "POST",
  headers: { authorization: `Token ${RECALL_API_KEY}`, "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({
    meeting_url: meetingUrl,
    bot_name: "Gomon",
    metadata: { callId },
    recording_config: {
      transcript: { provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } } },
      realtime_endpoints: [{ type: "webhook", url: webhook.toString(), events: ["transcript.data"] }],
    },
    automatic_audio_output: { in_call_recording: { data: { kind: "mp3", b64_data: greeting.toString("base64") } } },
  }),
});
const text = await res.text();
if (!res.ok) { console.error(`Recall ${res.status}: ${text}`); process.exit(1); }
const bot = JSON.parse(text) as { id: string };

const { db } = await connect();
const owner = await cols(db).users.findOne({ email: process.env.OWNER_EMAIL || "rob@gomon.dev" }, { projection: { _id: 1 } });
await cols(db).calls.updateOne(
  { _id: callId as never },
  {
    $set: { botId: bot.id, meetingUrl, voiceOut: "recall" },
    $setOnInsert: {
      teamId: config.teamId, projectId: config.projectId, title: titleArg || "Design call", status: "live", startedAt: new Date(),
      memoryEnabled: true, templateId: DEFAULT_TEMPLATE_ID, utteranceSeq: 0, ...(owner ? { ownerUserId: String(owner._id) } : {}),
    },
  },
  { upsert: true },
);
await close();
console.log(JSON.stringify({ callId, botId: bot.id, meetingUrl, dashboard: `http://localhost:3000/sessions/${callId}` }, null, 2));
console.log("Admit 'Gomon' in the meeting when it asks to join.");
