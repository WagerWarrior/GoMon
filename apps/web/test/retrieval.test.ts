import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { freshDb, seedCall } from "./helpers";
import { correctMemory, lockItem } from "../lib/governance";
import { keysIn, merge, type Hit } from "../lib/retrieval";

const h = (id: ObjectId, via: string[] = ["vector"], score = 0.5): Hit => ({ _id: id, text: String(id), score, via });

test("keysIn: explicit memory IDs in speech resolve to stored keys", () => {
  assert.deepEqual(keysIn("what did we say in R-12 and d 9?"), ["R-12", "D-09"]);
  assert.deepEqual(keysIn("no ids here"), []);
});

test("merge: keyed hits first (moved, not duplicated), then fused, then fresh-only; nothing appears twice", () => {
  const [a, b, c, x] = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()];
  const out = merge([h(a), h(b, ["text"])], [h(b)], [h(a), h(c)]);
  assert.deepEqual(out.map((r) => String(r._id)), [b, a, c].map(String));
  assert.deepEqual(out[0].via, ["text", "key"]);
  assert.deepEqual(out[2].via, ["fresh"]);
  assert.deepEqual(merge([], [h(x)], []).map((r) => r.via), [["key"]], "a keyed memory the index missed still comes back");
});

test("a correction carries no stored vector (Atlas embeds text server-side), so the new text is what gets searched", async () => {
  const { ctx, d, done } = await freshDb();
  try {
    const { itemId } = await seedCall(d);
    const { memoryId } = await lockItem(ctx, itemId, "Priya");
    await d.collection("memories").updateOne({ _id: new ObjectId(memoryId) }, { $set: { embedding: [1, 0, 0] } }); // legacy client vector
    const { memoryId: v2 } = await correctMemory(ctx, memoryId, "Tiered limits, burst 2,000 req/s", "Priya");
    const n: any = await d.collection("memories").findOne({ _id: new ObjectId(v2) });
    assert.equal(n.embedding, undefined); assert.equal(n.text, "Tiered limits, burst 2,000 req/s");
  } finally { await done(); }
});
