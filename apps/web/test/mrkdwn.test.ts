import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRecap, inline } from "../lib/mrkdwn";

const TEXT = [
  "*Recap: Rate limits review* · 32 min · Rob, Priya",
  "We settled the limiter design.",
  "",
  "*Decided*",
  "• D-13: Every response carries X-RateLimit headers (Rob, Priya)",
  "• …and 2 more",
  "",
  "*Filed*",
  "• Rate limit ticket: https://github.com/acme/api/issues/7",
  "",
  "Full session: http://localhost:3000/sessions/checkpoint-3",
].join("\n");

test("recap splits into title, lead, sections with bullets", () => {
  const r = parseRecap(TEXT);
  assert.equal(r.title, "Recap: Rate limits review");
  assert.equal(r.sub, "32 min · Rob, Priya");
  assert.deepEqual(r.lead, ["We settled the limiter design."]);
  assert.deepEqual(r.sections.map((s) => [s.title, s.items.length]), [["Decided", 2], ["Filed", 1]]);
  assert.deepEqual(r.tail, ["Full session: http://localhost:3000/sessions/checkpoint-3"]);
});

test("text without sections keeps every line", () => {
  const r = parseRecap("*Recap: x*\n\nNo decisions were locked in this call.");
  assert.equal(r.sections.length, 0);
  assert.deepEqual(r.lead, ["No decisions were locked in this call."]);
});

test("inline marks keys, links and bold", () => {
  assert.deepEqual(inline("D-13: carries *headers* see https://x.dev/a."), [
    { t: "key", v: "D-13" }, { t: "text", v: ": carries " }, { t: "b", v: "headers" }, { t: "text", v: " see " }, { t: "url", v: "https://x.dev/a", label: "x.dev/a" }, { t: "text", v: "." },
  ]);
  assert.deepEqual(inline("<https://slack.com/x|the thread>"), [{ t: "url", v: "https://slack.com/x", label: "the thread" }]);
  assert.deepEqual(inline("plain"), [{ t: "text", v: "plain" }]);
});
