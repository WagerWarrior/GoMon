import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { answer } from "../lib/answer";

const cited = [{ id: "m1", key: "D-07", text: "Tiered token-bucket limits; enterprise burst 2,000 req/s" }];

function fakeAnthropic(reply: (body: any) => [number, any]) {
  const seen: any[] = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const body = JSON.parse(b); seen.push({ body, key: req.headers["x-api-key"] });
      const [code, j] = reply(body); res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j));
    });
  });
  return new Promise<{ url: string; seen: any[]; close: () => Promise<void> }>((ok) => srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as any; ok({ url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => srv.close(() => r())) });
  }));
}

test("no LLM key: retrieval-only answer quotes the top memory; memory off cites nothing", async () => {
  const on = await answer("flat 100 rps?", true, cited, {});
  assert.equal(on.by, "retrieval"); assert.match(on.text, /Tiered token-bucket/);
  const off = await answer("flat 100 rps?", false, [], {});
  assert.equal(off.by, "retrieval"); assert.match(off.text, /Memory is off/);
});

test("anthropic: memories go into the prompt with their keys, the reply is the answer", async () => {
  const f = await fakeAnthropic(() => [200, { content: [{ type: "text", text: "That conflicts with D-07." }] }]);
  try {
    const a = await answer("flat 100 rps?", true, cited, { LLM_PROVIDER: "anthropic", LLM_API_KEY: "k", ANTHROPIC_BASE_URL: f.url });
    assert.equal(a.by, "llm"); assert.equal(a.text, "That conflicts with D-07.");
    assert.equal(f.seen[0].key, "k"); assert.match(f.seen[0].body.messages[0].content, /\[D-07\] Tiered token-bucket/);
    const off = await answer("flat 100 rps?", false, [], { LLM_PROVIDER: "anthropic", LLM_API_KEY: "k", ANTHROPIC_BASE_URL: f.url });
    assert.doesNotMatch(f.seen[1].body.messages[0].content, /D-07/, "memory off sends no memories");
    assert.equal(off.by, "llm");
  } finally { await f.close(); }
});

test("anthropic error: falls back to the retrieval answer and says why", async () => {
  const f = await fakeAnthropic(() => [401, { error: { message: "invalid x-api-key" } }]);
  try {
    const a = await answer("q", true, cited, { LLM_PROVIDER: "anthropic", LLM_API_KEY: "bad", ANTHROPIC_BASE_URL: f.url });
    assert.equal(a.by, "retrieval"); assert.match(a.text, /Tiered/); assert.match(a.note!, /401: invalid x-api-key/);
  } finally { await f.close(); }
});
