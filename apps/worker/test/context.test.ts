import { test } from "node:test";
import assert from "node:assert/strict";
import { issueLine } from "../src/context.ts";

const base = { number: 25, title: "D-09: No synchronous per-request writes", state: "open", created_at: "2026-11-14T20:00:00Z" };

test("an open issue Gomon filed says so, with its labels and who has it", () => {
  const s = issueLine({ ...base, labels: [{ name: "gomon" }, { name: "decision" }], assignees: [{ login: "Roppax" }] });
  assert.equal(s.id, "#25");
  assert.equal(s.line, "issue #25 [open] filed by you from memory D-09: No synchronous per-request writes (opened 2026-11-14; labels gomon, decision; assigned to Roppax)");
});

test("an issue a person opened is not claimed, and says unassigned", () => {
  const s = issueLine({ ...base, number: 20, title: "[P0] Apply scoped provenance checks" });
  assert.equal(s.line, "issue #20 [open] [P0] Apply scoped provenance checks (opened 2026-11-14; unassigned)");
});

test("a closed issue is history: it keeps its state and is not presented as a current filing", () => {
  const s = issueLine({ ...base, number: 9, state: "closed", labels: [{ name: "gomon" }] });
  assert.match(s.line, /^issue #9 \[closed\] D-09/);
});

test("a pull request reads as a PR", () => {
  assert.match(issueLine({ ...base, number: 14, pull_request: {} }).line, /^PR #14 \[open\]/);
});
