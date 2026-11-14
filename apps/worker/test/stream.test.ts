import { test } from "node:test";
import assert from "node:assert/strict";
import { readStream } from "../src/stream.ts";

const enc = new TextEncoder();
async function* chunks(parts: string[]) { for (const p of parts) yield enc.encode(p); }
const ev = (o: unknown) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
const START = ev({ type: "message_start", message: { usage: { input_tokens: 5200, cache_read_input_tokens: 4100 } } });
const text = (t: string) => ev({ type: "content_block_delta", delta: { type: "text_delta", text: t } });
const END = ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 31 } });

test("text arrives piece by piece, in order, with stop reason and usage", async () => {
  const got: string[] = [];
  const r = await readStream(chunks([START, text("D-09 says "), text("no sync writes."), END]), (d) => got.push(d));
  assert.deepEqual(got, ["D-09 says ", "no sync writes."]);
  assert.equal(r.stopReason, "end_turn");
  assert.deepEqual(r.usage, { input_tokens: 5200, cache_read_input_tokens: 4100, output_tokens: 31 });
});

test("an event split across two network chunks is read once, whole", async () => {
  const whole = START + text("Hello there.") + END;
  for (const cut of [10, 60, whole.indexOf("Hello") + 3, whole.length - 5]) {
    const got: string[] = [];
    const r = await readStream(chunks([whole.slice(0, cut), whole.slice(cut)]), (d) => got.push(d));
    assert.equal(got.join(""), "Hello there.", `cut at ${cut}`);
    assert.equal(r.stopReason, "end_turn");
  }
});

test("pings and other event types are ignored; a multi-byte character split across chunks survives", async () => {
  const bytes = enc.encode(START + ev({ type: "ping" }) + text("“Zürich” is fine.") + END);
  const at = bytes.indexOf(0xc3) + 1; // inside "ü"
  const got: string[] = [];
  await readStream((async function* () { yield bytes.slice(0, at); yield bytes.slice(at); })(), (d) => got.push(d));
  assert.equal(got.join(""), "“Zürich” is fine.");
});

test("an error event in the stream throws with the API's message", async () => {
  await assert.rejects(readStream(chunks([START, text("D-09"), ev({ type: "error", error: { message: "Overloaded" } })]), () => {}), /Overloaded/);
});

test("max_tokens is reported, so a cut sentence can be dropped", async () => {
  const r = await readStream(chunks([START, text("One. Two is cut"), ev({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 140 } })]), () => {});
  assert.equal(r.stopReason, "max_tokens");
});
