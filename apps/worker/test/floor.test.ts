import { test } from "node:test";
import assert from "node:assert/strict";
import { bargeIn, gateToWake } from "../src/floor.ts";
import type { Analysis } from "../src/llm.ts";

const analysis = (over: Partial<Analysis>): Analysis => ({
  addressed: false, replyKind: "none", reply: "", sources: [], newItems: [], conflicts: [], agreement: { itemRefs: [], agreedBy: [] },
  objection: false, command: { type: "none", memoryId: "", itemRef: "", newText: "", query: "" },
  github: { op: "none" } as Analysis["github"], suggestion: "", ...over,
});

// Live, call-202611142054-291b: the model marked these addressed and Gomon answered, though nobody said its name.
test("no wake word: the model's reply, command and GitHub op are dropped; captured items stay", () => {
  const a = gateToWake(analysis({
    addressed: true, replyKind: "grounded", reply: "R-02 needs Globex data kept in the EU.", sources: ["R-02"],
    command: { type: "share_link", memoryId: "", itemRef: "", newText: "", query: "github link" },
    github: { op: "create_issue" } as Analysis["github"],
    newItems: [{ kind: "question", text: "How do we resolve EU residency?" }],
  }), false);
  assert.equal(a.addressed, false);
  assert.equal(a.reply, "");
  assert.equal(a.replyKind, "none");
  assert.equal(a.command.type, "none");
  assert.equal(a.github.op, "none");
  assert.equal(a.newItems.length, 1);
});

test("wake word: the reply stands and addressed is forced on", () => {
  const a = gateToWake(analysis({ addressed: false, replyKind: "conversational", reply: "Yes, I can hear you." }), true);
  assert.equal(a.addressed, true);
  assert.equal(a.reply, "Yes, I can hear you.");
});

const SAYING = "Q-03 is the open question: a separate eu-central-1 Atlas cluster for EU tenants, or a global one.";

test("barge-in: nothing to stop while Gomon is silent", () => {
  assert.equal(bargeIn("stop stop stop please stop talking now", null), null);
});
test("barge-in: 'stop' stops it at once", () => {
  assert.equal(bargeIn("Stop.", SAYING), "stop_word");
  assert.equal(bargeIn("okay Gomon stop", SAYING), "stop_word");
});
test("barge-in: five words over it stop it; four short ones under 1.2 s do not", () => {
  assert.equal(bargeIn("no that is not what I meant", SAYING), "talk_over");
  assert.equal(bargeIn("yeah okay sure", SAYING, 400), null);
});
test("barge-in: talking for 1.2 s stops it", () => {
  assert.equal(bargeIn("well actually", SAYING, 1300), "talk_over");
  assert.equal(bargeIn("mm", SAYING, 1300), null);
});
test("barge-in: Gomon's own voice coming back through the meeting audio is not an interruption", () => {
  assert.equal(bargeIn("Q-03 is the open question a separate EU central one Atlas cluster", SAYING, 2500), null);
  assert.equal(bargeIn("stop", "I'll stop the rollout once the EU cluster is live."), null);
});
