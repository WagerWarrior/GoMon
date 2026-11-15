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

import { ticketSummary, type GhIssue, type Names } from "../src/context.ts";

const NAMES: Names = new Map([["naidx0", "Max Naidenov"], ["roppax", "Robert Reder"], ["wagerwarrior", "Tamir Azbel"]]);
const iss = (number: number, title: string, logins: string[] = [], state = "open"): GhIssue => ({ number, title, state, created_at: "2026-11-14T00:00:00Z", assignees: logins.map((login) => ({ login })) });

test("open tickets are sorted by whether someone has them, with names instead of logins", () => {
  const s = ticketSummary([iss(26, "C-02: postmortems", ["naidx0"]), iss(25, "D-09: no sync writes", ["Roppax"]), iss(24, "D-17: global cluster"), iss(23, "[P2] adapter"), iss(9, "old", [], "closed")], NAMES);
  assert.match(s, /^OPEN TICKETS: 4 open GitHub issues\.$/m);
  assert.match(s, /^WITH NOBODY ASSIGNED \(2\): #24 D-17: global cluster; #23 \[P2\] adapter\.$/m);
  assert.match(s, /^ASSIGNED \(2\): #26 C-02: postmortems -> Max Naidenov; #25 D-09: no sync writes -> Robert Reder\.$/m);
  assert.match(s, /only Max Naidenov, Robert Reder, Tamir Azbel\./);
});

test("a ticket never appears in both lists, and closed ones and pull requests are in neither", () => {
  const all = [iss(1, "a", ["naidx0"]), iss(2, "b"), iss(3, "c", [], "closed"), { ...iss(4, "d"), pull_request: {} }];
  const s = ticketSummary(all, NAMES);
  const free = /WITH NOBODY ASSIGNED \(\d+\): (.*)\.$/m.exec(s)![1], taken = /^ASSIGNED \(\d+\): (.*)\.$/m.exec(s)![1];
  assert.equal(free, "#2 b");
  assert.equal(taken, "#1 a -> Max Naidenov");
});

test("an issue line gives the assignee's name when the login is known", () => {
  assert.match(issueLine({ ...base, assignees: [{ login: "Roppax" }] }, NAMES).line, /assigned to Robert Reder\)$/);
  assert.match(issueLine({ ...base, assignees: [{ login: "stranger" }] }, NAMES).line, /assigned to stranger\)$/);
});

test("a filing a demo reset reverted is not listed as a filed ticket (K-05 still 'had issue 34' after the reset)", async () => {
  const { filedTicketsQuery } = await import("../src/platform.ts");
  const q = filedTicketsQuery("team-1");
  assert.equal(q.teamId, "team-1");
  assert.deepEqual(q.externalId, { $type: "string" });
  assert.deepEqual(q.reverted, { $ne: true });
});
