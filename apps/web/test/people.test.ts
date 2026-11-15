import { test } from "node:test";
import assert from "node:assert/strict";
import { peopleChoices } from "../lib/people";

test("the listener's name list: who is in the Meet now first, then who was, then the team; once each, never Gomon", () => {
  const r = peopleChoices({ liveParticipants: [{ name: "Robert Reder" }, { name: "Max Naidenov" }], participants: ["Max Naidenov", "Tamir Azbel"] }, ["Max Naidenov", "Robert Reder", "Tamir Azbel", "Gomon"]);
  assert.deepEqual(r.inCall, ["Robert Reder", "Max Naidenov"]);
  assert.deepEqual(r.choices, ["Robert Reder", "Max Naidenov", "Tamir Azbel"]);
});

test("no live list (no events tunnel for this call): inCall is null and the team still fills the list", () => {
  const r = peopleChoices({ participants: ["Max Naidenov"] }, ["Robert Reder"]);
  assert.equal(r.inCall, null);
  assert.deepEqual(r.choices, ["Max Naidenov", "Robert Reder"]);
  assert.deepEqual(peopleChoices(null, []), { inCall: null, choices: [] });
});

test("a one-word short form of a fuller name in the list is left out (members carry aliases as their own rows)", () => {
  const r = peopleChoices({ liveParticipants: [{ name: "Max Naidenov" }, { name: "Robert Reder" }] }, ["Max", "Rob", "Tamir", "Tamir Azbel", "Lena"]);
  assert.deepEqual(r.choices, ["Max Naidenov", "Robert Reder", "Tamir Azbel", "Lena"]);
});
