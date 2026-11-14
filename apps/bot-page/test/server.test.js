// In-process integration tests: real HTTP server, fake utterance API and fake ElevenLabs on random ports.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer, configFromEnv } from "../src/server.js";
import { recallEvent, w, sign, SECRET } from "./fixtures.js";

const listen = (srv) => new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${srv.address().port}`)));
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("timed out waiting for condition");
};

// Fake utterance API: records bodies; `failNext` makes the next N calls 500.
const received = [];
let failNext = 0;
const sink = http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  if (failNext > 0) { failNext--; res.writeHead(500).end(); return; }
  received.push(JSON.parse(b)); res.writeHead(201).end("{}");
});
// Fake ElevenLabs streaming endpoint.
const elCalls = [];
const el = http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  elCalls.push({ url: req.url, key: req.headers["xi-api-key"], body: JSON.parse(b) });
  res.writeHead(200, { "content-type": "audio/mpeg" });
  res.write(Buffer.from([0xff, 0xfb])); setTimeout(() => res.end(Buffer.from([1, 2, 3])), 20);
});

let signed, tokened, base, tokenBase;
const logs = [];
before(async () => {
  const sinkUrl = await listen(sink), elUrl = await listen(el);
  const common = { ...configFromEnv({}), utteranceApiUrl: `${sinkUrl}/api/utterances`, elBaseUrl: elUrl,
    elKey: "test-key", elVoice: "voice-1", log: (...a) => logs.push(a.join(" ")) };
  signed = createServer({ ...common, webhookSecret: SECRET });
  tokened = createServer({ ...common, webhookToken: "s3cret" });
  base = await listen(signed); tokenBase = await listen(tokened);
});
after(() => {
  for (const s of [signed, tokened]) { s.closeClients(); s.close(); }
  sink.close(); el.close();
});

const postSigned = (body, { path = "/recall/webhook/?callId=call-1", headers } = {}) => {
  const raw = JSON.stringify(body);
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(headers ?? sign(raw)) }, body: raw });
};

test("signed final transcript -> exactly one utterance with the right speaker", async () => {
  received.length = 0;
  const ev = recallEvent("transcript.data", [w("Use", 4, 4.2), w("token", 4.3, 4.6), w("buckets.", 4.7, 5.1)],
    { participant: { id: 100, name: "Tamir" } });
  const r = await postSigned(ev);
  assert.equal(r.status, 200);
  await until(() => received.length === 1);
  const u = received[0];
  assert.equal(u.callId, "call-1");
  assert.equal(u.speaker.displayName, "Tamir");
  assert.equal(u.text, "Use token buckets.");
  assert.equal(u.source, "recall");
  assert.equal(u.sourceKey, "recall:bot-1:100:4.000");
  assert.ok(Date.parse(u.startedAt) < Date.parse(u.endedAt));
  assert.ok(Math.abs(Date.parse(u.endedAt) - Date.now()) < 5000, "endedAt is near wall clock");
});

test("Recall redelivery of the same segment is not posted twice", async () => {
  received.length = 0;
  const ev = recallEvent("transcript.data", [w("Agreed.", 9, 9.5)]);
  await postSigned(ev); await postSigned(ev); await postSigned(ev);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(received.length, 1);
});

test("partials are acked 200 and never posted", async () => {
  received.length = 0;
  const r = await postSigned(recallEvent("transcript.partial_data", [w("Flat", 11, 11.2)]));
  assert.equal(r.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 0);
});

test("bad signature -> 401, nothing posted", async () => {
  received.length = 0;
  const ev = recallEvent("transcript.data", [w("Forged", 20, 21)]);
  const r = await postSigned(ev, { headers: sign(JSON.stringify(ev) + "x") });
  assert.equal(r.status, 401);
  const r2 = await postSigned(ev, { headers: {} });
  assert.equal(r2.status, 401);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 0);
});

test("path works with and without trailing slash; invalid JSON is still 200 (no Recall retry storm)", async () => {
  received.length = 0;
  const ev = recallEvent("transcript.data", [w("Slashless", 30, 31)]);
  assert.equal((await postSigned(ev, { path: "/recall/webhook?callId=call-1" })).status, 200);
  await until(() => received.length === 1);
  const raw = "{not json";
  const r = await fetch(base + "/recall/webhook/?callId=call-1", { method: "POST", headers: sign(raw), body: raw });
  assert.equal(r.status, 200);
});

test("callId falls back to bot.metadata.callId", async () => {
  received.length = 0;
  const ev = recallEvent("transcript.data", [w("Meta", 40, 41)]);
  ev.data.bot.metadata = { callId: "call-meta" };
  await postSigned(ev, { path: "/recall/webhook/" });
  await until(() => received.length === 1);
  assert.equal(received[0].callId, "call-meta");
});

test("utterance API 500s are retried until delivered", async () => {
  received.length = 0; failNext = 2;
  await postSigned(recallEvent("transcript.data", [w("Retry", 50, 51)]));
  await until(() => received.length === 1, 3000);
  assert.equal(received[0].text, "Retry");
});

test("utterances from one bot share a monotonic clock", async () => {
  received.length = 0;
  await postSigned(recallEvent("transcript.data", [w("First", 60, 61)], { botId: "bot-clock" }));
  await postSigned(recallEvent("transcript.data", [w("Second", 62, 63)], { botId: "bot-clock" }));
  await until(() => received.length === 2);
  const [a, b] = [...received].sort((x, y) => x.text.localeCompare(y.text));
  assert.ok(Date.parse(a.startedAt) < Date.parse(b.startedAt));
});

test("token mode: ?token= required when no secret is configured", async () => {
  received.length = 0;
  const raw = JSON.stringify(recallEvent("transcript.data", [w("Tok", 70, 71)]));
  assert.equal((await fetch(`${tokenBase}/recall/webhook/?callId=c&token=nope`, { method: "POST", body: raw })).status, 401);
  assert.equal((await fetch(`${tokenBase}/recall/webhook/?callId=c&token=s3cret`, { method: "POST", body: raw })).status, 200);
  await until(() => received.length === 1);
});

test("/say -> SSE event -> /tts streams ElevenLabs audio -> ack", async () => {
  const ctrl = new AbortController();
  const stream = await fetch(`${base}/say/stream`, { signal: ctrl.signal });
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  const r = await fetch(`${base}/say`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sayId: "s-1", text: "Locking in: token buckets.", priority: "high" }) });
  assert.equal(r.status, 202);
  assert.equal((await r.json()).pages, 1);
  let buf = "";
  while (!buf.includes("event: say")) buf += dec.decode((await reader.read()).value);
  const data = JSON.parse(buf.split("event: say\ndata: ")[1].split("\n")[0]);
  assert.deepEqual(data, { sayId: "s-1", text: "Locking in: token buckets.", priority: "high" });
  ctrl.abort();

  const audio = await fetch(`${base}/tts/s-1`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await audio.arrayBuffer()).length, 5);
  const call = elCalls.at(-1);
  assert.equal(call.key, "test-key");
  assert.match(call.url, /^\/v1\/text-to-speech\/voice-1\/stream\?output_format=mp3_22050_32$/);
  assert.deepEqual(call.body, { text: "Locking in: token buckets.", model_id: "eleven_flash_v2_5" });

  const ack = await fetch(`${base}/say/ack`, { method: "POST", body: JSON.stringify({ sayId: "s-1", state: "done" }) });
  assert.equal(ack.status, 204);
  assert.equal((await fetch(`${base}/tts/s-1`)).status, 404, "done sayIds are forgotten");
});

test("/say with callId reaches only that call's page (query param or page Referer)", async () => {
  const ctrl = new AbortController();
  const open = async (path, headers = {}) => {
    const r = await fetch(base + path, { signal: ctrl.signal, headers });
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } } catch { /* aborted */ } })();
    return () => buf;
  };
  const a = await open("/say/stream?callId=call-A");
  const b = await open("/say/stream", { referer: `${base}/?callId=call-B` });
  const none = await open("/say/stream");
  const say = (body) => fetch(`${base}/say`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  assert.equal((await say({ sayId: "to-b", text: "only B", callId: "call-B" })).pages, 1);
  assert.equal((await say({ sayId: "to-all", text: "everyone" })).pages, 3);
  assert.equal((await say({ sayId: "to-nobody", text: "no page", callId: "call-Z" })).pages, 0);
  await until(() => b().includes("to-all") && a().includes("to-all") && none().includes("to-all"));
  assert.ok(b().includes("to-b"));
  assert.ok(!a().includes("to-b") && !none().includes("to-b"));
  ctrl.abort();
});

test("audio generation starts at /say, and a repeated line is served from cache", async () => {
  const say = (sayId, text) => fetch(`${base}/say`, { method: "POST", body: JSON.stringify({ sayId, text }) });
  const requests = () => elCalls.filter((c) => c.body.text === "On it.").length; // earlier tests' audio may still be arriving
  await say("pre-1", "On it.");
  await until(() => requests() === 1); // requested before any page asked for /tts
  const first = Buffer.from(await (await fetch(`${base}/tts/pre-1`)).arrayBuffer());
  assert.equal(first.length, 5);
  await say("pre-2", "On it.");
  const second = await fetch(`${base}/tts/pre-2`);
  assert.equal(second.status, 200);
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), first);
  assert.equal(requests(), 1, "no second ElevenLabs request for the same text");
});

test("/say validation", async () => {
  const post = (b) => fetch(`${base}/say`, { method: "POST", body: JSON.stringify(b) });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ text: "x", sayId: "../etc" })).status, 400);
  assert.equal((await fetch(`${base}/say`, { method: "POST", body: "{bad" })).status, 400);
});

test("/health reports webhook auth mode and stats", async () => {
  const h = await (await fetch(`${base}/health`)).json();
  assert.equal(h.webhookAuth, "signature");
  assert.equal(h.tts, true);
  assert.ok(h.stats.rejected >= 2);
  assert.ok(h.stats.duplicates >= 2);
});
