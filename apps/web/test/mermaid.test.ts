import test from "node:test";
import assert from "node:assert/strict";
import { buildDiagram } from "../lib/mermaid";
import { percentile, stageStats } from "../lib/stats";

const m = (o: any) => ({ _id: o.key ?? o.text, teamId: "t", projectId: "p", kind: "decision", status: "active", version: 1, ...o });

test("diagram contains only ACTIVE memories and links by cited keys", () => {
  const d = buildDiagram([
    m({ key: "R-12", kind: "requirement", text: "Acme bursts to 2,000 req/s for 60 s" }),
    m({ key: "D-20", text: "Tiered token bucket meets R-12 with enterprise burst" }),
    m({ key: "D-99", text: "Forgotten thing", status: "forgotten" }),
    m({ key: "D-98", text: "Old thing", status: "superseded" }),
    m({ key: "D-07", text: "Single region us-east-1" })], "Northwind API");
  assert.match(d, /^flowchart LR/);
  assert.match(d, /nR_12 --> nD_20/);
  assert.ok(!d.includes("Forgotten thing") && !d.includes("Old thing"));
  assert.match(d, /P --> nD_07/); // unlinked active memory still appears
});

test("diagram never throws on quotes/newlines and marks corrected versions", () => {
  const d = buildDiagram([m({ key: "D-1", text: 'say "hi"\nnow', version: 2 })], 'Proj "x"');
  assert.ok(!/say "hi"/.test(d)); assert.match(d, /\(v2\)/);
});

test("percentiles", () => {
  assert.equal(percentile([], 50), null); assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2); assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
  assert.deepEqual(stageStats([{ stage: "a", ms: 10 }, { stage: "a", ms: 30 }]), [{ stage: "a", n: 2, p50: 10, p95: 30 }]);
});
