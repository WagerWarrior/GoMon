// Shared test fixtures. Payload shape per docs.recall.ai/docs/real-time-event-payloads (transcript.data):
// word timestamps carry only `relative` seconds, end_timestamp may be null, participant.id is an int.
import { createHmac } from "node:crypto";

export const recallEvent = (event, words, { botId = "bot-1", participant = { id: 7, name: "Rob" } } = {}) => ({
  event,
  data: {
    data: {
      words,
      language_code: "en",
      participant: { ...participant, is_host: false, platform: "google_meet", extra_data: {}, email: null },
    },
    realtime_endpoint: { id: "re-1", metadata: {} },
    transcript: { id: "tr-1", metadata: {} },
    recording: { id: "rec-1", metadata: {} },
    bot: { id: botId, metadata: {} },
  },
});
export const w = (text, s, e) => ({
  text,
  start_timestamp: { relative: s },
  end_timestamp: e == null ? null : { relative: e },
});

export const SECRET = "whsec_" + Buffer.from("test-secret-0123456789").toString("base64");
export function sign(rawBody, { secret = SECRET, id = "msg_1", ts = Math.floor(Date.now() / 1000) } = {}) {
  const key = Buffer.from(secret.slice(6), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}` };
}
