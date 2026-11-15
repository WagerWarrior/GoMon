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
  assert.deepEqual(ep![0].events, ["participant_events.join", "participant_events.leave", "participant_events.speech_on", "participant_events.speech_off"]);
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

test("Recall refusing the request with events still gets Gomon into the meeting, without them", async () => {
  const { createBot } = await import("../src/recall.ts");
  const sent: Body[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("elevenlabs")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    const body = JSON.parse(String(init?.body)) as Body;
    sent.push(body);
    return body.recording_config ? new Response('{"recording_config":["unknown field"]}', { status: 400 }) : new Response('{"id":"bot-9"}', { status: 201 });
  }) as typeof fetch;
  try {
    assert.equal(await createBot("https://meet.google.com/abc-defg-hij", "call-1", { ...rc, eventsUrl: "https://a.trycloudflare.com" }), "bot-9");
    assert.equal(sent.length, 2);
    assert.ok(sent[0].recording_config);
    assert.equal(sent[1].recording_config, undefined);
  } finally { globalThis.fetch = real; }
});

test("any other failure is still an error (no second bot)", async () => {
  const { createBot } = await import("../src/recall.ts");
  let calls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes("elevenlabs")) return new Response(new Uint8Array([1]), { status: 200 });
    calls++;
    return new Response("boom", { status: 500 });
  }) as typeof fetch;
  try {
    await assert.rejects(createBot("https://meet.google.com/abc-defg-hij", "call-2", { ...rc, eventsUrl: "https://a.trycloudflare.com" }), /Recall 500/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = real; }
});
