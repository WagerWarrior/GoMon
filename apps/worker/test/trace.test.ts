import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLabel, traceLine, type Trace } from "../src/trace.ts";

const t: Trace = { memoryOn: true, memoryKeys: ["D-17", "R-02", "K-01", "Q-03", "D-01", "C-01"], memoryMs: 212, knowledgeHits: 3, knowledgeMs: 240, records: 61, openIssues: 8, model: "claude-sonnet-5-5", modelMs: 1630, totalMs: 2140 };

test("the trace names each step and its result, with the model and total time in seconds", () => {
  assert.equal(
    traceLine("Gomon", t),
    "Gomon answered in 2.1 s  |  Atlas memory: 6 hits (D-17, R-02, K-01, Q-03, +2)  |  Past meetings: 3 hits  |  Tickets: 8 open, 61 records read  |  Sonnet 5.5: 1.6 s",
  );
});

test("when the first sentence was spoken early, the trace says when", () => {
  assert.match(traceLine("Gomon", { ...t, firstMs: 1180 }), /Sonnet 5\.5: 1\.6 s \(first sentence at 1\.2 s\)$/);
  assert.doesNotMatch(traceLine("Gomon", { ...t, firstMs: null }), /first sentence/);
});

test("no hits and one hit read correctly", () => {
  const line = traceLine("Gomon", { ...t, memoryKeys: [], knowledgeHits: 1, openIssues: 1 });
  assert.match(line, /Atlas memory: no hits/);
  assert.match(line, /Past meetings: 1 hit /);
  assert.match(line, /Tickets: 1 open,/);
});

test("memory off: says so and lists no searches", () => {
  const line = traceLine("Gomon", { ...t, memoryOn: false });
  assert.match(line, /memory off for this call/);
  assert.doesNotMatch(line, /Atlas memory|Past meetings/);
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

import { stepDone, stepFound, stepSearching } from "../src/trace.ts";

test("the thinking steps read as plain sentences, in order: searching, found, answered", () => {
  assert.equal(stepSearching("Gomon", true), "Gomon is thinking: searching Atlas memory, past meetings and GitHub tickets…");
  assert.equal(
    stepFound("Gomon", { memoryOn: true, memoryKeys: ["D-17", "R-02", "K-01", "Q-03", "D-01"], knowledgeHits: 3, openIssues: 9, records: 70 }, 6),
    "Gomon found: 5 memories (D-17, R-02, K-01, Q-03, +1), 3 past-meeting hits, 9 open tickets (6 with nobody assigned). Writing the answer…",
  );
  assert.equal(stepDone("Gomon", { model: "claude-sonnet-5-5", modelMs: 1630, totalMs: 2140 }, 480), "Gomon answered in 2.1 s (search 0.5 s, Sonnet 5.5 1.6 s).");
});

test("found step: no memories, one hit, one ticket; memory off lists tickets only", () => {
  assert.equal(stepFound("Gomon", { memoryOn: true, memoryKeys: [], knowledgeHits: 1, openIssues: 1, records: 5 }, 0), "Gomon found: no matching memories, 1 past-meeting hit, 1 open ticket (0 with nobody assigned). Writing the answer…");
  assert.equal(stepFound("Gomon", { memoryOn: false, memoryKeys: ["D-01"], knowledgeHits: 4, openIssues: 2, records: 5 }, 1), "Gomon found: 2 open tickets (1 with nobody assigned). Writing the answer…");
});
