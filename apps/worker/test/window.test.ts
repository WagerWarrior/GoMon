import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWindow, tokensOf } from "../src/window.ts";

const line = (n: number) => `line ${n} ${"x".repeat(32)}`; // 10 tokens each

test("under budget: every line is kept, in section order, under its title", () => {
  const w = buildWindow([
    { title: "", lines: ["This call: Design review"], budget: 50, keep: "head" },
    { title: "TEAM MEMORY", lines: ["- R-02: EU data stays in the EU"], budget: 50, keep: "head" },
    { title: "RECENT TURNS", lines: ["Rob: hey Gomon", "Max: agreed"], budget: 50, keep: "tail" },
  ]);
  assert.equal(w.text, "This call: Design review\nTEAM MEMORY:\n- R-02: EU data stays in the EU\nRECENT TURNS:\nRob: hey Gomon\nMax: agreed");
  assert.equal(w.dropped, 0);
});

test("ranked results over budget keep the best (first) lines", () => {
  const w = buildWindow([{ title: "TEAM MEMORY", lines: [1, 2, 3, 4, 5].map(line), budget: 30, keep: "head" }]);
  assert.match(w.text, /line 1 /);
  assert.match(w.text, /line 3 /);
  assert.doesNotMatch(w.text, /line 4 /);
  assert.deepEqual(w.use[0], { title: "TEAM MEMORY", tokens: 30, lines: 3, dropped: 2 });
});

test("a transcript over budget keeps the newest (last) turns, still in spoken order", () => {
  const w = buildWindow([{ title: "RECENT TURNS", lines: [1, 2, 3, 4, 5].map(line), budget: 20, keep: "tail" }]);
  assert.doesNotMatch(w.text, /line 3 /);
  assert.ok(w.text.indexOf("line 4 ") < w.text.indexOf("line 5 "));
  assert.equal(w.use[0].dropped, 3);
});

test("the whole window never exceeds the sum of its budgets", () => {
  const big = Array.from({ length: 400 }, (_, i) => line(i));
  const w = buildWindow([
    { title: "A", lines: big, budget: 100, keep: "head" },
    { title: "B", lines: big, budget: 200, keep: "tail" },
  ]);
  assert.ok(w.tokens <= 300);
  assert.ok(tokensOf(w.text) <= 300 + 4);
});

test("one huge line cannot eat a section; an empty section shows its placeholder or is left out", () => {
  const w = buildWindow([
    { title: "WORKSPACE", lines: ["y".repeat(5000), "- #14 open issue"], budget: 100, keep: "head" },
    { title: "TEAM MEMORY", lines: [], budget: 100, keep: "head", empty: "(none matched)" },
    { title: "OPEN CALL ITEMS", lines: [], budget: 100, keep: "head" },
  ]);
  assert.match(w.text, /- #14 open issue/);
  assert.match(w.text, /TEAM MEMORY:\n\(none matched\)/);
  assert.doesNotMatch(w.text, /OPEN CALL ITEMS/);
});
