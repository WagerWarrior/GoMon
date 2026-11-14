import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLabel, traceLine, type Trace } from "../src/trace.ts";

const t: Trace = { memoryOn: true, memoryKeys: ["D-17", "R-02", "K-01", "Q-03", "D-01", "C-01"], memoryMs: 212, knowledgeHits: 3, knowledgeMs: 240, records: 61, openIssues: 8, model: "claude-sonnet-5-5", modelMs: 1630, totalMs: 2140 };

test("the trace names each step, its result and its time in seconds", () => {
  assert.equal(
    traceLine("Gomon", t),
    "Gomon · how I answered (2.1 s): Atlas memory search: 6 hits (D-17, R-02, K-01, Q-03, +2) in 0.2 s · past meetings and ADRs: 3 hits in 0.2 s · read 61 team records, 8 open GitHub issues · Sonnet 5.5 wrote the answer in 1.6 s",
  );
});

test("when the first sentence was spoken early, the trace says when", () => {
  assert.match(traceLine("Gomon", { ...t, firstMs: 1180 }), /Sonnet 5\.5 wrote the answer in 1\.6 s, first sentence to the voice at 1\.2 s$/);
  assert.doesNotMatch(traceLine("Gomon", { ...t, firstMs: null }), /first sentence/);
});

test("no hits and one hit read correctly", () => {
  const line = traceLine("Gomon", { ...t, memoryKeys: [], knowledgeHits: 1, openIssues: 1 });
  assert.match(line, /Atlas memory search: no hits in 0\.2 s/);
  assert.match(line, /ADRs: 1 hit in/);
  assert.match(line, /1 open GitHub issue ·/);
});

test("memory off: says so and lists no searches", () => {
  const line = traceLine("Gomon", { ...t, memoryOn: false });
  assert.match(line, /memory is off for this call/);
  assert.doesNotMatch(line, /Atlas memory search|past meetings/);
});

test("the trace fits one Meet chat message (500 characters) and carries no link", () => {
  const line = traceLine("Gomon", { ...t, memoryKeys: Array.from({ length: 40 }, (_, i) => `D-${i + 10}`) });
  assert.ok(line.length < 500, String(line.length));
  assert.doesNotMatch(line, /https?:/);
});

test("model ids read as names", () => {
  assert.equal(modelLabel("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelLabel("claude-haiku-5-5"), "Haiku 5.5");
  assert.equal(modelLabel("claude-opus-5-5-20261001"), "Opus 5.5");
  assert.equal(modelLabel("my-model"), "my-model");
});
