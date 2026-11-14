import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { filedIssueQuery } from "../src/github-intent.ts";

// Second demo (Nov 14): K-05 was filed live as issue 34; asking to file it again said "K-05 already has issue 34". A reset
// (scripts/reset-demo.ts) marks that filing reverted, so the next demo files K-05 fresh.
test("a filing the demo reset reverted no longer counts as filed; failed and denied ones never did", () => {
  const m = new ObjectId();
  const q = filedIssueQuery("northwind-platform", m) as Record<string, unknown>;
  assert.deepEqual(q.memoryId, m);
  assert.deepEqual(q.status, { $nin: ["failed", "denied"] });
  assert.deepEqual(q.reverted, { $ne: true });
});
