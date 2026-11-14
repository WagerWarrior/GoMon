import { test } from "node:test";
import assert from "node:assert/strict";
import { firstSentence, issueLinks, restAfter, spokenLine } from "../src/speech.ts";

test("a link is never read aloud", () => {
  assert.equal(spokenLine("Here's the direct link, issue #25: https://github.com/WagerWarrior/MongoDB/issues/25, and I'm posting it in the Meet chat now."),
    "Here's the direct link, issue 25: and I'm posting it in the Meet chat now.");
  assert.ok(!/github|https?:/.test(spokenLine("It's at https://github.com/WagerWarrior/MongoDB/issues/25.")));
});
test("periods inside numbers and names do not end a sentence", () => {
  const t = "D-15 keeps buckets in the shared gateway Redis cluster. It fixes Acme's throttling and adds about 0.2 ms per request. Nothing else changed.";
  assert.equal(spokenLine(t), "D-15 keeps buckets in the shared gateway Redis cluster. It fixes Acme's throttling and adds about 0.2 ms per request.");
});
test("an answer cut by the token limit loses its unfinished sentence", () => {
  assert.equal(spokenLine("D-09 bans synchronous billing writes. K-04 explains why: the billing Postgres saturated at 3,000 writes a second in the", true), "D-09 bans synchronous billing writes.");
});
test("a very long sentence is cut at a clause, never mid-phrase", () => {
  const long = `The Globex kickoff locked three things, ${"and one more thing that matters a lot here, ".repeat(8)}and that is all`;
  const out = spokenLine(long);
  assert.ok(out.split(/\s+/).length <= 42);
  assert.match(out, /[a-z]\.$/);
});
test("issues named in a line become links", () => {
  assert.deepEqual(issueLinks("D-09 is tracked in issue 25, and #27 covers D-12.", "WagerWarrior/MongoDB").map((l) => l.url),
    ["https://github.com/WagerWarrior/MongoDB/issues/25", "https://github.com/WagerWarrior/MongoDB/issues/27"]);
  assert.deepEqual(issueLinks("D-12 allows 3,000 requests a second for 60 seconds.", "o/r"), []);
});

test("the first sentence is ready only once the next one has started", () => {
  assert.equal(firstSentence("D-09 says no synchronous writes to billing."), null);
  assert.equal(firstSentence("D-09 says no synchronous writes to billing. "), null);
  assert.equal(firstSentence("D-09 says no synchronous writes to billing. I"), "D-09 says no synchronous writes to billing.");
  assert.equal(firstSentence("D-09 says no synchronous writes to billing. Issue 25 tracks"), "D-09 says no synchronous writes to billing.");
});

test("a period inside a number or a domain does not end the first sentence", () => {
  assert.equal(firstSentence("It adds about 0.8 ms at p99, within C-03. Redis"), "It adds about 0.8 ms at p99, within C-03.");
  assert.equal(firstSentence("The repo is on github.com and it has eight open"), null);
});

test("a very short opener is not spoken on its own", () => {
  assert.equal(firstSentence("Yes. Eight are open"), null);
  assert.equal(firstSentence("Sure thing. D-09 says"), null);
});

test("the first sentence is made voice-safe like the whole answer (no link, no #)", () => {
  assert.equal(firstSentence("Ticket D-09 is issue #25 (https://github.com/o/r/issues/25) and open. It"), "Ticket D-09 is issue 25 and open.");
});

test("what is left after the first sentence; nothing when the answer was one sentence or was shortened differently", () => {
  const first = "D-09 says no synchronous writes to billing.";
  assert.equal(restAfter(`${first} Issue 25 tracks it.`, first), "Issue 25 tracks it.");
  assert.equal(restAfter(first, first), "");
  assert.equal(restAfter("Something else entirely.", first), "");
});

test("first sentence plus rest is exactly the whole spoken answer", () => {
  const raw = "D-17 locks one global Atlas cluster with zone sharding. Issue #24 tracks it, and it is still unassigned. A third sentence that is dropped.";
  const first = firstSentence(raw)!;
  const full = spokenLine(raw);
  assert.equal(`${first} ${restAfter(full, first)}`, full);
});
