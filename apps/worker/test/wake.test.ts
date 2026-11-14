import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWake } from "../src/wake.ts";

// Real committed segments from Atlas (Nov 14) where people addressed Gomon and the old parser missed it, because Scribe
// and Recall deliver whole sentences and the wake word is not always the first word.
const MISSED_LIVE: [string, string][] = [
  ["Right. Yo, yo. Chill on the talking for a sec. Hey, hey, Gomon. Can you see my last message actually", "can you see my last message actually"],
  ["okay cool cool hey gohan can you hear me right now", "can you hear me right now"],
  ["So yeah. Gomon, what did we decide about rate limits?", "what did we decide about rate limits"],
];

test("wake word mid-segment, after a sentence end or a greeting, is addressed", () => {
  for (const [text, rest] of MISSED_LIVE) {
    const w = parseWake(text);
    assert.equal(w.addressed, true, text);
    assert.equal(w.rest, rest, text);
  }
});

test("wake word at the start still works as before", () => {
  assert.deepEqual(parseWake("Gomon, can we please start"), { addressed: true, rest: "can we please start", heardAs: "gomon" });
  assert.equal(parseWake("hey goman what's the plan").addressed, true);
  assert.equal(parseWake("Gomon what did u last hear").rest, "what did u last hear");
});

test("ordinary speech is not a wake", () => {
  for (const t of ["go on, tell me more", "We should go on with the plan.", "Can you tell me what the ticket was about, et cetera?",
    "Hello, hello. Can you hear me? Hey", "The Mongo cluster is slow today.", "I think so. Man, that was long."]) {
    assert.equal(parseWake(t).addressed, false, t);
  }
});
