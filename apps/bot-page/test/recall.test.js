import { test } from "node:test";
import assert from "node:assert/strict";
import { recallEvent, w, sign, SECRET } from "./fixtures.js";
import { toUtterance, segmentBounds, verifyRecallSignature } from "../src/recall.js";

const ANCHOR = Date.parse("2026-11-14T15:00:00.000Z");

test("final segment becomes an utterance with ISO times from the anchor", () => {
  const u = toUtterance(
    recallEvent("transcript.data", [w("Flat", 1.25, 1.5), w("100", 1.6, 2), w("per", 2.1, 2.3), w("tenant.", 2.4, 3.05)]),
    "call-1", { anchorMs: ANCHOR });
  assert.deepEqual(u, {
    callId: "call-1",
    sourceKey: "recall:bot-1:7:1.250",
    speaker: { displayName: "Rob" },
    text: "Flat 100 per tenant.",
    startedAt: "2026-11-14T15:00:01.250Z",
    endedAt: "2026-11-14T15:00:03.050Z",
    source: "recall",
  });
});

test("without an anchor, times are null (never fabricated)", () => {
  const u = toUtterance(recallEvent("transcript.data", [w("Hi", 1, 2)]), "c");
  assert.equal(u.startedAt, null);
  assert.equal(u.endedAt, null);
});

test("null end_timestamp falls back to the last known time", () => {
  assert.deepEqual(segmentBounds(recallEvent("transcript.data", [w("a", 1, 1.4), w("b", 1.5, null)])), { start: 1, end: 1.5 });
});

test("separate punctuation tokens attach to the previous word", () => {
  const u = toUtterance(recallEvent("transcript.data", [w("Agreed", 1, 2), w(",", 2, 2), w("ship", 2, 3), w("it", 3, 4), w("?", 4, 4)]), "c");
  assert.equal(u.text, "Agreed, ship it?");
});

test("partial segments never become utterances", () => {
  assert.equal(toUtterance(recallEvent("transcript.partial_data", [w("Flat", 1, 2)]), "call-1"), null);
});

test("empty and whitespace-only segments are dropped", () => {
  assert.equal(toUtterance(recallEvent("transcript.data", []), "call-1"), null);
  assert.equal(toUtterance(recallEvent("transcript.data", [w(" ", 1, 2)]), "call-1"), null);
});

test("missing participant name -> Unknown speaker", () => {
  const u = toUtterance(recallEvent("transcript.data", [w("Hi", 1, 2)], { participant: { id: 3, name: null } }), "c");
  assert.equal(u.speaker.displayName, "Unknown speaker");
});

test("same segment yields the same sourceKey; different speakers/starts differ", () => {
  const e = recallEvent("transcript.data", [w("Agreed", 3, 4)]);
  assert.equal(toUtterance(e, "c").sourceKey, toUtterance(structuredClone(e), "c").sourceKey);
  const other = recallEvent("transcript.data", [w("Agreed", 3, 4)], { participant: { id: 8, name: "Max" } });
  assert.notEqual(toUtterance(e, "c").sourceKey, toUtterance(other, "c").sourceKey);
});

// --- signature verification (docs: Authenticating requests from Recall.ai) ---
test("valid signature verifies", () => {
  const raw = JSON.stringify({ a: 1 });
  assert.deepEqual(verifyRecallSignature({ secret: SECRET, headers: sign(raw), rawBody: raw }), { ok: true });
});

test("tampered body, wrong secret, stale timestamp and missing headers are rejected", () => {
  const raw = JSON.stringify({ a: 1 });
  assert.equal(verifyRecallSignature({ secret: SECRET, headers: sign(raw), rawBody: raw + " " }).ok, false);
  const wrong = "whsec_" + Buffer.from("other").toString("base64");
  assert.equal(verifyRecallSignature({ secret: SECRET, headers: sign(raw, { secret: wrong }), rawBody: raw }).ok, false);
  const old = sign(raw, { ts: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(verifyRecallSignature({ secret: SECRET, headers: old, rawBody: raw }).reason, "stale timestamp");
  assert.equal(verifyRecallSignature({ secret: SECRET, headers: {}, rawBody: raw }).ok, false);
});

test("rotation: any matching v1 entry in a space-separated header passes", () => {
  const raw = "{}";
  const h = sign(raw);
  h["webhook-signature"] = `v1,AAAA ${h["webhook-signature"]}`;
  assert.equal(verifyRecallSignature({ secret: SECRET, headers: h, rawBody: raw }).ok, true);
});

