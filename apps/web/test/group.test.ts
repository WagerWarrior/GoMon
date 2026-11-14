import { test } from "node:test";
import assert from "node:assert/strict";
import { bursts, collapse, groupBy } from "../lib/group";

const t = (s: number) => new Date(Date.UTC(2026, 10, 14, 12, 0, s)).toISOString();

test("bursts split on gaps larger than the limit, in time order", () => {
  const b = bursts([{ at: t(50) }, { at: t(0) }, { at: t(10) }, { at: t(200) }], (x) => x.at, 60_000);
  assert.deepEqual(b.map((g) => g.length), [3, 1]);
  assert.equal(b[0][0].at, t(0));
});

test("bursts keep a gap equal to the limit in the same burst, and handle empty input", () => {
  assert.equal(bursts([{ at: t(0) }, { at: t(60) }], (x) => x.at, 60_000).length, 1);
  assert.deepEqual(bursts([], (x: any) => x.at), []);
});

test("collapse merges only neighbours with the same key", () => {
  const c = collapse(["a", "a", "b", "a"], (x) => x);
  assert.deepEqual(c.map((x) => [x.item, x.n]), [["a", 2], ["b", 1], ["a", 1]]);
});

test("groupBy keeps first-seen group order", () => {
  assert.deepEqual(groupBy([3, 1, 4, 1, 5], (x) => (x % 2 ? "odd" : "even")).map(([k, v]) => [k, v.length]), [["odd", 4], ["even", 1]]);
});
