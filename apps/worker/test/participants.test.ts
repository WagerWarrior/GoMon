import { test } from "node:test";
import assert from "node:assert/strict";
import { participantNames } from "../src/participants.ts";

test("names come out trimmed, once each, in meeting order", () => {
  assert.deepEqual(
    participantNames([{ id: 100, name: "Max Naidenov", is_host: true }, { id: 101, name: "  Robert   Reder " }, { id: 102, name: "max naidenov" }], "Gomon"),
    ["Max Naidenov", "Robert Reder"],
  );
});

test("the bot itself and unnamed entries are left out", () => {
  assert.deepEqual(participantNames([{ name: "Gomon" }, { name: "gomon" }, { name: "" }, { name: null }, {}, { name: "Tamir Azbel" }], "Gomon"), ["Tamir Azbel"]);
});

test("anything that is not a list gives no names", () => {
  assert.deepEqual(participantNames(null), []);
  assert.deepEqual(participantNames({ detail: "not found" }), []);
  assert.deepEqual(participantNames("oops"), []);
});
