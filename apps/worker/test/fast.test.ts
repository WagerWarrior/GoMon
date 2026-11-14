import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsFastReply } from "../src/fast.ts";

test("a question to Gomon is answered by the fast lane, wherever the name is", () => {
  assert.equal(wantsFastReply("Hey Gomon, what did we decide about billing writes?"), true);
  assert.equal(wantsFastReply("What did we decide about billing writes? Hey, Gomon."), true);
});

test("an action is never answered by the fast lane, also when the name comes after the request", () => {
  // Live Nov 14: this exact line got "there's nothing to assign" while the action lane filed and assigned the issue.
  assert.equal(wantsFastReply("Awesome. So can you actually assign it to Max, please? Thank you so much. Hey, Gomon."), false);
  assert.equal(wantsFastReply("Hey Gomon, create the tickets."), false);
  assert.equal(wantsFastReply("Turn C-02 into a GitHub issue, hey Gomon."), false);
});

test("talk that does not name Gomon gets no fast answer", () => {
  assert.equal(wantsFastReply("Can you assign it to Max, please?"), false);
  assert.equal(wantsFastReply("What did we decide about billing writes?"), false);
});
