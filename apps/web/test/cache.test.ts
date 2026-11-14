import { test } from "node:test";
import assert from "node:assert/strict";
import { cached } from "../lib/db";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("cached: one call inside the fresh window", async () => {
  let n = 0; const f = async () => ++n;
  assert.equal(await cached("t1", 1000, f), 1);
  assert.equal(await cached("t1", 1000, f), 1);
  assert.equal(n, 1);
});

test("cached: stale value returns at once, one background refresh, then the new value", async () => {
  let n = 0; const f = async () => { await wait(20); return ++n; };
  assert.equal(await cached("t2", 10, f), 1);
  await wait(15);
  assert.equal(await cached("t2", 10, f), 1, "stale value served immediately");
  assert.equal(await cached("t2", 10, f), 1, "no second refresh while one runs");
  await wait(30);
  assert.equal(await cached("t2", 10, f), 2, "refreshed value");
  assert.equal(n, 2);
});

test("cached: past maxStale waits for a fresh value; failures are not cached", async () => {
  let n = 0; const f = async () => ++n;
  await cached("t3", 1, f, 5); await wait(10);
  assert.equal(await cached("t3", 1, f, 5), 2);
  await assert.rejects(cached("t4", 1000, async () => { throw new Error("x"); }));
  await wait(1);
  assert.equal(await cached("t4", 1000, async () => 7), 7);
});
