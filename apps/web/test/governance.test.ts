import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { freshDb, seedCall, TEAM, PROJECT } from "./helpers";
import { checkPolicy, lockItem, rejectItem, correctMemory, forgetMemory, enqueueAction, PolicyDenied } from "../lib/governance";

test("policy is default-deny: unknown member, missing policy, and wrong role", async () => {
  const { ctx, d, done } = await freshDb();
  try {
    assert.equal((await checkPolicy(d, TEAM, PROJECT, "Nobody", "lock_decision")).allowed, false);
    assert.equal((await checkPolicy(d, TEAM, PROJECT, "Priya", "delete_everything")).allowed, false);
    assert.equal((await checkPolicy(d, TEAM, PROJECT, "Lena", "lock_decision")).allowed, false);  // observer
    assert.equal((await checkPolicy(d, TEAM, PROJECT, "Marcus", "forget_memory")).allowed, false); // engineer may not forget
    const ok = await checkPolicy(d, TEAM, PROJECT, "Priya", "forget_memory");
    assert.equal(ok.allowed, true); assert.ok(ok.policyId);
  } finally { await done(); }
});

test("lock promotes the item to canonical memory with lock proof, clears TTL, and audits, in one transaction", async () => {
  const { ctx, d, done } = await freshDb();
  try {
    const { itemId } = await seedCall(d);
    const r = await lockItem(ctx, itemId, "Priya");
    const mem = await d.collection("memories").findOne({ _id: new ObjectId(r.memoryId) });
    assert.equal(mem!.status, "active"); assert.equal(mem!.version, 1);
    assert.ok(mem!.lock.lockedAt instanceof Date); assert.deepEqual(mem!.lock.participants, ["Priya", "Marcus"]);
    assert.equal(mem!.sourceRefs.length, 1); assert.equal(mem!.teamId, TEAM); assert.equal(mem!.projectId, PROJECT);
    const item = await d.collection("call_items").findOne({ _id: new ObjectId(itemId) });
    assert.equal(item!.status, "promoted"); assert.equal("expiresAt" in item!, false);
    assert.equal(await d.collection("audit_events").countDocuments({ type: "memory_promoted" }), 1);
    const again = await lockItem(ctx, itemId, "Priya"); assert.equal(again.already, true);
    assert.equal(await d.collection("memories").countDocuments({}), 1);
  } finally { await done(); }
});

test("a denied actor cannot lock; nothing changes but a denial is audited", async () => {
  const { ctx, d, done } = await freshDb();
  try {
    const { itemId } = await seedCall(d);
    await assert.rejects(lockItem(ctx, itemId, "Lena"), PolicyDenied);
    assert.equal(await d.collection("memories").countDocuments({}), 0);
    assert.equal((await d.collection("call_items").findOne({ _id: new ObjectId(itemId) }))!.status, "locking");
    assert.equal(await d.collection("audit_events").countDocuments({ type: "lock_denied", actor: "Lena" }), 1);
  } finally { await done(); }
});

test("transaction is atomic: if the audit write fails nothing is promoted", async () => {
  const { ctx, d, done } = await freshDb();
  try {
    const { itemId } = await seedCall(d);
    await d.createCollection("audit_events", { validator: { $jsonSchema: { required: ["neverPresent"] } }, validationAction: "error" });
    await assert.rejects(lockItem(ctx, itemId, "Priya"));
    assert.equal(await d.collection("memories").countDocuments({}), 0);
    assert.equal((await d.collection("call_items").findOne({ _id: new ObjectId(itemId) }))!.status, "locking");
  } finally { await done(); }
});

test("correct supersedes with history and the old version leaves the active set immediately", async () => {
  const { ctx, d, done } = await freshDb();
  try {
    const { itemId } = await seedCall(d);
    const { memoryId } = await lockItem(ctx, itemId, "Priya");
    const r = await correctMemory(ctx, memoryId, "Enterprise burst 3,000 req/s for 60 s", "Marcus");
    const active = await d.collection("memories").find({ teamId: TEAM, projectId: PROJECT, status: "active" }).toArray();
    assert.equal(active.length, 1); assert.equal(active[0].text, "Enterprise burst 3,000 req/s for 60 s");
    assert.equal(active[0].version, 2); assert.equal(String(active[0].supersedes), memoryId);
    const old = await d.collection("memories").findOne({ _id: new ObjectId(memoryId) });
    assert.equal(old!.status, "superseded"); assert.equal(String(old!.supersededBy), r.memoryId);
    assert.ok(active[0].lock.lockedAt instanceof Date);
    await assert.rejects(correctMemory(ctx, memoryId, "again", "Priya"), /superseded/);
  } finally { await done(); }
});

test("forget tombstones (history kept), is policy-gated to leads, and leaves the active set", async () => {
  const { ctx, d, done } = await freshDb();
  try {
    const { itemId } = await seedCall(d);
    const { memoryId } = await lockItem(ctx, itemId, "Priya");
    await assert.rejects(forgetMemory(ctx, memoryId, "Marcus"), PolicyDenied);
    assert.equal(await d.collection("memories").countDocuments({ status: "active" }), 1);
    await forgetMemory(ctx, memoryId, "Priya");
    assert.equal(await d.collection("memories").countDocuments({ status: "active" }), 0);
    const m = await d.collection("memories").findOne({ _id: new ObjectId(memoryId) });
    assert.equal(m!.status, "forgotten"); assert.equal(m!.forgottenBy, "Priya"); assert.equal(m!.text.length > 0, true);
  } finally { await done(); }
});

test("reject marks the item and audits; a promoted item cannot be rejected", async () => {
  const { ctx, d, done } = await freshDb();
  try {
    const { itemId } = await seedCall(d);
    await rejectItem(ctx, itemId, "Marcus");
    assert.equal((await d.collection("call_items").findOne({ _id: new ObjectId(itemId) }))!.status, "rejected");
    const s2 = await seedCall(d).catch(() => null); // second seed would duplicate the call id; not needed
    const it2 = await d.collection("call_items").insertOne({ callId: "call-1", kind: "decision", text: "x", status: "locking" });
    await lockItem(ctx, String(it2.insertedId), "Priya");
    await assert.rejects(rejectItem(ctx, String(it2.insertedId), "Priya"), /already promoted/);
  } finally { await done(); }
});

test("enqueueAction writes the outbox only, and a double click resolves to ONE action (idempotency key)", async () => {
  const { ctx, d, done } = await freshDb();
  try {
    const a = await enqueueAction(ctx, "create_issue", { title: "T" }, "Priya", "call-1", "mem-1");
    const b = await enqueueAction(ctx, "create_issue", { title: "T" }, "Priya", "call-1", "mem-1");
    assert.equal(a.duplicate, false); assert.equal(b.duplicate, true); assert.equal(a.actionId, b.actionId);
    const docs = await d.collection("actions").find({}).toArray();
    assert.equal(docs.length, 1); assert.equal(docs[0].status, "queued"); assert.equal(docs[0].requestedBy, "Priya");
    assert.equal(docs[0].externalId, undefined); assert.equal(docs[0].policyCheck, undefined); // connector owns both
  } finally { await done(); }
});
