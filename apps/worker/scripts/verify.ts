/**
 * Live checks against Atlas for the Statement Two claims. Uses its own throwaway call/memories and cleans up.
 *   npm run verify
 * 1. hybrid retrieval finds the right seeded memory (vector and lexical)
 * 2. isolation: another team's memory is never returned, even for a query that matches it best
 * 3. the memories validator rejects an active call decision without lock proof (and accepts it with proof)
 * 4. TTL index exists on call_items.expiresAt
 */
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { close, cols, connect } from "../src/db.ts";
import { retrieve } from "../src/retrieve.ts";

const { db } = await connect();
const c = cols(db);
const scope = { teamId: config.teamId, projectId: config.projectId };
const results: string[] = [];
const check = async (name: string, fn: () => Promise<void>) => {
  const t = Date.now();
  await fn();
  results.push(`ok  ${name} (${Date.now() - t} ms)`);
};

await check("hybrid retrieval: burst proposal retrieves R-12", async () => {
  const hits = await retrieve(c, scope, "let's do a flat 100 requests per second per tenant, no bursts");
  console.log("  top:", hits.slice(0, 3).map((h) => `${h.key}[${h.via.join("+")}]`).join(", "));
  assert.ok(hits.slice(0, 3).some((h) => h.key === "R-12"), "R-12 should be in the top 3");
});

await check("lexical: an exact ID like R-15 resolves", async () => {
  const hits = await retrieve(c, scope, "what does R-15 say");
  assert.equal(hits[0]?.key, "R-15");
  assert.ok(hits[0].via.includes("text"));
});

await check("isolation: Orion's flat-100 decision never leaks into Northwind retrieval", async () => {
  const hits = await retrieve(c, scope, "Rate limits are a flat 100 requests per second per tenant with no burst", 10);
  const other = await c.memories.findOne({ teamId: "orion-payments", key: "D-01" });
  assert.ok(other, "other-team fixture missing: run npm run seed");
  assert.ok(!hits.some((h) => String(h._id) === String(other._id)), "other team's memory leaked");
  assert.ok(hits.every((h) => h.key !== "R-03"));
});

await check("validator: active call decision without lock proof is rejected", async () => {
  const base = { ...scope, kind: "decision" as const, text: "verify-only", status: "active" as const, version: 1, origin: "call" as const,
    sourceRefs: [{ type: "call" as const, callId: "verify", utteranceIds: [] }], createdAt: new Date(), updatedAt: new Date() };
  await assert.rejects(c.memories.insertOne({ ...base }), /validation/i);
  const ok = await c.memories.insertOne({ ...base, lock: { lockedAt: new Date(), participants: ["Rob"], lockedBy: "Rob", via: "human" } });
  await c.memories.deleteOne({ _id: ok.insertedId });
});

await check("TTL: call_items.expiresAt expires scratch items", async () => {
  const idx = await c.callItems.indexes();
  assert.ok(idx.some((i) => i.key?.expiresAt === 1 && i.expireAfterSeconds === 0));
});

console.log(results.join("\n"));
await close();
