import { test } from "node:test";
import assert from "node:assert/strict";
import { chimeGate, namedInPartial } from "../src/voice.ts";

test("one chime per turn: the partial, the commit and the second channel sound once", () => {
  assert.equal(chimeGate("c1", 10_000), true); // partial "hey Gomon"
  assert.equal(chimeGate("c1", 10_300), false); // next partial
  assert.equal(chimeGate("c1", 12_500), false); // committed sentence, or the meeting-tab channel
  assert.equal(chimeGate("c1", 14_100), true); // a new question later
  assert.equal(chimeGate("c2", 10_100), true); // another call is independent
});

test("the name is caught mid-sentence in a partial, spelled out only", () => {
  assert.equal(namedInPartial("okay so hey Gomon what did we"), true);
  assert.equal(namedInPartial("Go mon, what"), true);
  assert.equal(namedInPartial("go on then"), false);
  assert.equal(namedInPartial("we should use mongo here"), false);
});
