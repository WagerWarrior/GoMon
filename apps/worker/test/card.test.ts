import { test } from "node:test";
import assert from "node:assert/strict";
import { cardSvg, clock, renderCard, FRAME_MS, type CardState } from "../src/card.ts";

const STATES = Object.keys(FRAME_MS) as CardState[];

test("every state draws its own card", () => {
  const svgs = STATES.map((state) => cardSvg({ state, elapsedMs: 0, frame: 0 }));
  assert.equal(new Set(svgs).size, STATES.length);
  for (const [i, s] of STATES.entries()) assert.match(svgs[i], new RegExp(`>${{ listening: "Listening", thinking: "Thinking", speaking: "Speaking", locking: "Locking in" }[s]}`));
});

test("thinking animates: the lit dot moves each frame and the timer counts", () => {
  const f = (frame: number, elapsedMs: number) => cardSvg({ state: "thinking", elapsedMs, frame, detail: "heard Max, checking team memory" });
  assert.notEqual(f(0, 0), f(1, 0));
  assert.equal(f(0, 0), f(3, 0)); // three dots, then round again
  assert.match(f(0, 1400), />1\.4 s</);
  assert.match(f(0, 1400), /heard Max, checking team memory/);
});

test("locking counts the 10 s veto window down to zero", () => {
  assert.match(cardSvg({ state: "locking", elapsedMs: 3200, frame: 3 }), />7 s</);
  assert.match(cardSvg({ state: "locking", elapsedMs: 20_000, frame: 20 }), />0 s</);
});

test("listening is one still frame; the others animate", () => {
  assert.equal(FRAME_MS.listening, 0);
  assert.equal(cardSvg({ state: "listening", elapsedMs: 0, frame: 0 }), cardSvg({ state: "listening", elapsedMs: 900, frame: 4 }));
  assert.notEqual(cardSvg({ state: "speaking", elapsedMs: 0, frame: 0 }), cardSvg({ state: "speaking", elapsedMs: 0, frame: 1 }));
});

test("clock", () => {
  assert.deepEqual([600, 12_300, 65_000].map(clock), ["0.6 s", "12 s", "1:05"]);
});

test("detail text is escaped and clipped", () => {
  const svg = cardSvg({ state: "thinking", elapsedMs: 0, frame: 0, detail: `<b>& ${"x".repeat(80)}` });
  assert.ok(!svg.includes("<b>"));
  assert.match(svg, /&lt;b&gt;&amp; x+…</);
});

test("renders a JPEG", async () => {
  const b64 = await renderCard({ state: "thinking", elapsedMs: 1400, frame: 1 });
  assert.ok(b64, "sharp is a dependency of the worker");
  assert.deepEqual([...Buffer.from(b64, "base64").subarray(0, 3)], [0xff, 0xd8, 0xff]);
});
