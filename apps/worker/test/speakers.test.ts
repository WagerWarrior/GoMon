import { test } from "node:test";
import assert from "node:assert/strict";
import { speakerFor, type Span } from "../src/speakers.ts";

const T = Date.parse("2026-11-14T21:18:00Z");
const s = (name: string, from: number, to: number): Span => ({ name, start: T + from * 1000, end: T + to * 1000 });
// Rob talks 0-4 s, Max 5-9 s, Tamir 9.5-12 s, Gomon answers 13-16 s.
const SPANS = [s("Robert Reder", 0, 4), s("Max Naidenov", 5, 9), s("Tamir Azbel", 9.5, 12), s("Gomon", 13, 16)];
const at = (sec: number) => T + sec * 1000;

test("a line is given to the person who was talking while it was said", () => {
  assert.equal(speakerFor(SPANS, at(5), 10), "Robert Reder");   // committed 1 s after Rob stopped
  assert.equal(speakerFor(SPANS, at(10), 10), "Max Naidenov");
  assert.equal(speakerFor(SPANS, at(13), 6), "Tamir Azbel");
});
test("two remote people who shared one 'others' label come apart", () => {
  const names = [at(10), at(13)].map((t, i) => speakerFor(SPANS, t, i ? 6 : 10));
  assert.deepEqual(names, ["Max Naidenov", "Tamir Azbel"]);
});
test("the bot's own voice never names a line", () => {
  assert.equal(speakerFor(SPANS, at(17), 8, ["Gomon"]), null);
});
test("nobody talking, or two people talking equally, leaves the line as heard", () => {
  assert.equal(speakerFor(SPANS, at(40), 5), null);
  assert.equal(speakerFor([s("A", 0, 3), s("B", 0, 3)], at(4), 8), null);
});
