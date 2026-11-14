import { test } from "node:test";
import assert from "node:assert/strict";
import { issueLinks, spokenLine } from "../src/speech.ts";

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
