import test from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedCall, TEAM, PROJECT } from "./helpers";
import { lockItem, correctMemory, forgetMemory } from "../lib/governance";
import { embedMissing } from "../lib/retrieval";

const sc = { teamId: TEAM, projectId: PROJECT };
const fakeEmbed = (seen: string[]) => async (texts: string[]) => { seen.push(...texts); return texts.map(() => [1, 0, 0]); };

test("embedMissing: only active, in-scope memories without a vector; a correction becomes searchable, the old and forgotten never re-embed", async () => {
  const { ctx, d, done } = await freshDb();
  try {
    const { itemId } = await seedCall(d);
    const { memoryId } = await lockItem(ctx, itemId, "Priya");
    await d.collection("memories").insertOne({ teamId: "other-team", projectId: PROJECT, status: "active", text: "not ours" });

    let seen: string[] = [];
    assert.equal(await embedMissing(d, sc, fakeEmbed(seen)), 1);
    assert.deepEqual(seen, ["Tiered token-bucket limits with enterprise burst"]);
    assert.equal(await embedMissing(d, sc, fakeEmbed((seen = []))), 0, "idempotent: nothing left to embed");

    const { memoryId: v2 } = await correctMemory(ctx, String(memoryId), "Tiered limits, burst 2,000 req/s", "Priya");
    assert.equal(await embedMissing(d, sc, fakeEmbed((seen = []))), 1);
    assert.deepEqual(seen, ["Tiered limits, burst 2,000 req/s"]);

    await forgetMemory(ctx, String(v2), "Priya");
    assert.equal(await embedMissing(d, sc, fakeEmbed((seen = []))), 0);
    assert.equal(await d.collection("memories").countDocuments({ teamId: "other-team", embedding: { $exists: true } }), 0, "other teams untouched");
  } finally { await done(); }
});
