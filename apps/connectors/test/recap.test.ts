import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { freshDb, TEAM, PROJECT } from "./fakes";
import { sweepRecaps, buildRecap } from "../src/recap";

const ago = (ms: number) => new Date(Date.now() - ms);

async function endedCall(d: any, over: any = {}) {
  await d.collection("calls").updateOne({ _id: "call-1" }, { $set: { status: "ended", startedAt: ago(30 * 60_000), endedAt: ago(60_000), participants: ["Lena", "Priya"], utteranceSeq: 40,
    summary: "The team settled on tiered token buckets and agreed to return 429s with Retry-After.", ...over } });
}
async function record(d: any) {
  const mem = await d.collection("memories").insertOne({ teamId: TEAM, projectId: PROJECT, key: "D-16", kind: "decision", status: "active", version: 1, origin: "call", text: "Every response carries rate-limit headers",
    sourceRefs: [{ type: "call", callId: "call-1" }], lock: { lockedAt: ago(5 * 60_000), participants: ["Priya", "Lena"], via: "voice" } });
  await d.collection("memories").insertOne({ teamId: TEAM, projectId: PROJECT, key: "D-12", kind: "decision", status: "active", version: 1, origin: "call", text: "Tiered buckets (older call)",
    sourceRefs: [{ type: "call", callId: "call-0" }], lock: { lockedAt: ago(86_400_000) } });
  await d.collection("call_items").insertMany([
    { callId: "call-1", teamId: TEAM, projectId: PROJECT, kind: "action", text: "Priya drafts the 429 error format", status: "proposed", createdAt: ago(9e5) },
    { callId: "call-1", teamId: TEAM, projectId: PROJECT, kind: "open_question", text: "Do sandbox keys count toward limits?", status: "proposed", createdAt: ago(8e5) },
    { callId: "call-1", teamId: TEAM, projectId: PROJECT, kind: "action", text: "Rejected idea", status: "rejected", createdAt: ago(7e5) },
  ]);
  await d.collection("conflicts").insertOne({ callId: "call-1", teamId: TEAM, projectId: PROJECT, itemId: new ObjectId(), memoryId: new ObjectId(), memoryKey: "D-12", severity: "high", kind: "conflict", spoken: true, note: "Flat 100 req/s breaks the enterprise burst", createdAt: ago(6e5) });
  await d.collection("audit_events").insertOne({ teamId: TEAM, projectId: PROJECT, callId: "call-1", type: "memory_corrected", actor: "Priya", at: ago(4e5), reason: "burst is 3,000 not 2,000", ref: { key: "D-15" } });
  await d.collection("actions").insertOne({ callId: "call-1", teamId: TEAM, projectId: PROJECT, type: "create_issue", status: "confirmed", idempotencyKey: "create_issue:call-1:x:v1", requestedBy: "Priya", externalId: "7", externalUrl: "http://gh.test/issues/7", payload: { title: "D-16: headers" } });
  return mem.insertedId;
}

test("an ended call gets one recap: decisions, changes, owners' actions, open questions, memory pushback, filed links", async () => {
  const { d, done } = await freshDb();
  try {
    await endedCall(d); await record(d);
    assert.equal(await sweepRecaps(d), 1);
    const call: any = await d.collection("calls").findOne({ _id: "call-1" as any });
    const t: string = call.recap.text;
    assert.match(t, /Rate limits/);
    assert.match(t, /tiered token buckets/i, "rolling summary included");
    assert.match(t, /D-16.*rate-limit headers/);
    assert.doesNotMatch(t, /older call/, "decisions from other calls are not this call's");
    assert.match(t, /D-15.*burst is 3,000/);
    assert.match(t, /Priya drafts the 429 error format/);
    assert.doesNotMatch(t, /Rejected idea/);
    assert.match(t, /sandbox keys/);
    assert.match(t, /D-12.*Flat 100/);
    assert.match(t, /gh\.test\/issues\/7/);
    assert.deepEqual(call.recap.counts, { decisions: 1, changes: 1, actions: 1, questions: 1, conflicts: 1, filed: 1 });
    const acts = await d.collection("actions").find({ type: "post_slack" }).toArray();
    assert.equal(acts.length, 1);
    assert.equal(acts[0].idempotencyKey, "recap:call-1");
    assert.equal(acts[0].requestedBy, "Priya", "first participant allowed to post (Lena is an observer)");
    assert.equal(acts[0].payload.text, t);
    assert.equal(await sweepRecaps(d), 0, "a second sweep recaps nothing");
    assert.equal(await d.collection("actions").countDocuments({ type: "post_slack" }), 1);
  } finally { await done(); }
});

test("no recap for live calls, empty calls, or calls that ended long ago (seeded history)", async () => {
  const { d, done } = await freshDb();
  try {
    await d.collection("calls").insertMany([
      { _id: "live" as any, teamId: TEAM, projectId: PROJECT, status: "live", participants: ["Priya"], utteranceSeq: 9 },
      { _id: "empty" as any, teamId: TEAM, projectId: PROJECT, status: "ended", endedAt: ago(60_000), participants: ["Priya"], utteranceSeq: 0 },
      { _id: "old" as any, teamId: TEAM, projectId: PROJECT, status: "ended", endedAt: ago(30 * 86_400_000), participants: ["Priya"], utteranceSeq: 50 },
    ]);
    assert.equal(await sweepRecaps(d), 0);
    assert.equal(await d.collection("actions").countDocuments(), 0);
  } finally { await done(); }
});

test("with no participant allowed to post, the recap is still stored but nothing is queued", async () => {
  const { d, done } = await freshDb();
  try {
    await endedCall(d, { participants: ["Lena", "Guest"] });
    assert.equal(await sweepRecaps(d), 1);
    const call: any = await d.collection("calls").findOne({ _id: "call-1" as any });
    assert.ok(call.recap.text);
    assert.match(call.recap.note, /no participant may post_slack/);
    assert.equal(await d.collection("actions").countDocuments(), 0);
  } finally { await done(); }
});

test("an empty-but-real call still reads cleanly", async () => {
  const { d, done } = await freshDb();
  try {
    await endedCall(d, { summary: undefined });
    const r = await buildRecap(d, (await d.collection("calls").findOne({ _id: "call-1" as any }))!);
    assert.match(r.text, /No decisions were locked/);
    assert.deepEqual(r.counts, { decisions: 0, changes: 0, actions: 0, questions: 0, conflicts: 0, filed: 0 });
  } finally { await done(); }
});
