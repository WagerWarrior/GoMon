import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWake } from "../src/wake.js";

const addressed = (t) => parseWake(t).addressed;

test("close spellings are addressed without a greeting", () => {
  for (const t of ["Gomon, create the tickets", "go mon create the tickets", "goman create the tickets",
    "gomen create the tickets", "gourmand create the tickets", "gummon create the tickets"]) {
    const r = parseWake(t);
    assert.equal(r.addressed, true, t);
    assert.equal(r.rest, "create the tickets", t);
  }
});

test("spellings Recall produced in a live Meet are addressed after a greeting", () => {
  assert.deepEqual(parseWake("hey gourmand"), { addressed: true, rest: "", heardAs: "gourmand" });
  assert.deepEqual(parseWake("hey so man create the tickets"), { addressed: true, rest: "create the tickets", heardAs: "so man" });
  assert.equal(addressed("hey no man create the tickets"), true);
  assert.equal(addressed("hey go on create the tickets"), true);
  assert.equal(addressed("Hey, Gomon. What did we decide about billing?"), true);
});

test("the looser sound-alikes need the greeting", () => {
  for (const t of ["so man create the tickets", "no man create the tickets", "go on create the tickets"]) {
    assert.equal(addressed(t), false, t);
  }
});

test("the alias works after a greeting only", () => {
  assert.deepEqual(parseWake("hey mongo create the tickets"), { addressed: true, rest: "create the tickets", heardAs: "mongo" });
  assert.equal(addressed("mongo atlas is the source of truth"), false);
});

test("ordinary sentences are not addressed", () => {
  for (const t of ["we could log every request into billing", "so many tenants hit the limit", "come on that is too slow",
    "hello can you hear me", "hey rob what about redis", "hey man that is a lot", "hey max can you share",
    "hey guys can we start", "hey tamir are you there", "german users need this", "game on", "yeah", "",
    "the gomon bot is in the call", "go on", "ok go on"]) {
    assert.equal(addressed(t), false, t);
  }
});
