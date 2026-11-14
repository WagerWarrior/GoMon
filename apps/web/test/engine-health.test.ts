import { test } from "node:test";
import assert from "node:assert/strict";
import { endToEnd, pipeline, problems, type EngineInput } from "../lib/engine-health";

const NOW = Date.parse("2026-11-14T20:20:00Z");
const base = (): EngineInput => ({
  stages: { queue: { p50: 1830, p95: 2070, n: 6 }, retrieve: { p50: 523, p95: 771, n: 6 }, analyze: { p50: 2297, p95: 3866, n: 6 }, total: { p50: 3426, p95: 4454, n: 6 }, say_to_audio: { p50: 2316, p95: 3232, n: 4 } },
  workers: [{ id: "a:1", lastAt: "2026-11-14T20:15:00Z", n: 3 }], failed: 0, backlog: 0, heard15: 4, sources: { typed: 3, recall: 1 }, model: "claude-haiku-5-5",
});

test("pipeline has the six loop stages in order with tones from targets", () => {
  const p = pipeline(base());
  assert.deepEqual(p.map((n) => n.key), ["hear", "queue", "retrieve", "analyze", "act", "say_to_audio"]);
  assert.equal(p.find((n) => n.key === "retrieve")!.tone, "warn"); // 523 > 500
  assert.equal(p.find((n) => n.key === "analyze")!.tone, "good");
  assert.equal(p.find((n) => n.key === "hear")!.note, "4 in 15 min · typed 3 · recall 1");
});

test("end to end is loop plus speech, unknown until both are measured", () => {
  assert.equal(endToEnd(base()), 3426 + 2316);
  const e = base(); delete e.stages.say_to_audio; assert.equal(endToEnd(e), null);
});

test("questions answered by the fast lane are timed by fast_reply, not the full loop", () => {
  const e = base(); e.stages.fast_reply = { p50: 1400, p95: 2100, n: 5 };
  assert.equal(endToEnd(e), 1400 + 2316);
});

test("each problem has a case that produces only it", () => {
  assert.deepEqual(problems(base(), NOW), []);
  const two = base(); two.workers.push({ id: "b:2", lastAt: "2026-11-14T20:10:00Z", n: 1 });
  assert.match(problems(two, NOW).map((p) => p.text).join("|"), /^2 machines ran a worker .*\(a, b\)/);
  const restart = base(); restart.workers.push({ id: "a:9", lastAt: "2026-11-14T20:10:00Z", n: 1 });
  assert.deepEqual(problems(restart, NOW), [], "a restart on the same host is not a second worker");
  const stale = base(); stale.workers.push({ id: "b:2", lastAt: "2026-11-14T19:00:00Z", n: 1 });
  assert.deepEqual(problems(stale, NOW), []);
  const failed = base(); failed.failed = 2; assert.match(problems(failed, NOW)[0].text, /^2 batches failed/);
  const backlog = base(); backlog.backlog = 1; assert.match(problems(backlog, NOW)[0].text, /^1 utterance waiting/);
  const slow = base(); slow.stages.analyze = { p50: 6000, p95: 9000, n: 3 }; assert.match(problems(slow, NOW)[0].text, /^Think p50 6000 ms/);
});
