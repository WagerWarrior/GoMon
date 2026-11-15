import { test } from "node:test";
import assert from "node:assert/strict";
import { botRequestBody } from "../src/recall.ts";

const rc = { apiKey: "k", region: "us-west-2", publicBaseUrl: "", webhookToken: "tok", webhookSecret: "", botVariant: "web_4_core", eventsUrl: "" };
const media = { greetingMp3B64: "AAAA", cardJpegB64: "BBBB" };
type Body = { recording_config?: { realtime_endpoints: { type: string; url: string; events: string[] }[] }; automatic_audio_output?: unknown };

test("no tunnel: the bot only speaks and shows its card, no events are asked for", () => {
  const b = botRequestBody("https://meet.google.com/abc-defg-hij", "call-1", rc, media) as Body;
  assert.equal(b.recording_config, undefined);
  assert.ok(b.automatic_audio_output);
});

test("events tunnel: Recall sends join and leave events to it, with the call and the token, and nothing else changes", () => {
  const b = botRequestBody("https://meet.google.com/abc-defg-hij", "call-1", { ...rc, eventsUrl: "https://quiet-river.trycloudflare.com" }, media) as Body;
  const ep = b.recording_config?.realtime_endpoints;
  assert.equal(ep?.length, 1);
  assert.deepEqual(ep![0].events, ["participant_events.join", "participant_events.leave"]);
  const u = new URL(ep![0].url);
  // Recall needs the "/" before the query string (HTTP 400 otherwise).
  assert.equal(u.origin + u.pathname, "https://quiet-river.trycloudflare.com/recall/events/");
  assert.equal(u.searchParams.get("callId"), "call-1");
  assert.equal(u.searchParams.get("token"), "tok");
  assert.ok(b.automatic_audio_output);
});

test("an events URL that is not https, or no webhook token, asks for no events", () => {
  assert.equal((botRequestBody("https://meet.google.com/x", "c", { ...rc, eventsUrl: "http://localhost:3011" }, media) as Body).recording_config, undefined);
  assert.equal((botRequestBody("https://meet.google.com/x", "c", { ...rc, eventsUrl: "https://a.trycloudflare.com", webhookToken: "" }, media) as Body).recording_config, undefined);
});
