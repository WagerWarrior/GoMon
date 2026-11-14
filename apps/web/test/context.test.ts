import { test } from "node:test";
import assert from "node:assert/strict";
import { chipLabel, isKeyQuery, originLabel, quote, SOURCES, type Hit } from "../lib/context";

test("key queries search by key prefix, words search by meaning", () => {
  for (const q of ["D-13", "d-1", "R-", "K", "dr"]) assert.equal(isKeyQuery(q), true, q);
  for (const q of ["rate limits", "billing", "D-13 rate", "", "abc"]) assert.equal(isKeyQuery(q), false, q);
});

test("every source quotes with where it came from", () => {
  const cases: [Hit, string][] = [
    [{ src: "memory", id: "1", title: "D-13", tag: "decision", meta: "fact", text: "Every  response\ncarries X-RateLimit." }, "[D-13 · decision · fact] Every response carries X-RateLimit."],
    [{ src: "items", id: "2", title: "action", tag: "locked", text: "Lena runs a spike" }, "[This call · action · locked] Lena runs a spike"],
    [{ src: "quotes", id: "3", title: "Robert Reder", meta: "14:54", text: "can you hear me" }, "\"can you hear me\" (Robert Reder, 14:54)"],
    [{ src: "meetings", id: "4", title: "Globex SSO kickoff", meta: "Nov 10", text: "Kickoff for SSO" }, "[Meeting: Globex SSO kickoff, Nov 10] Kickoff for SSO"],
  ];
  for (const [h, want] of cases) assert.equal(quote(h), want);
  assert.deepEqual(new Set(cases.map(([h]) => h.src)), new Set(SOURCES.map((s) => s.key)));
});

test("chip labels stay short and origins read as words", () => {
  assert.equal(chipLabel({ src: "quotes", id: "1", title: "Shay", text: "a".repeat(40) }), `Shay: ${"a".repeat(28)}…`);
  assert.equal(chipLabel({ src: "memory", id: "1", title: "D-13", text: "x" }), "D-13");
  assert.equal(originLabel("doc"), "fact");
  assert.equal(originLabel("call"), "from a meeting");
});
