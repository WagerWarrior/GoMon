import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { freshDb, TEAM, PROJECT } from "./fakes";
import { ensureWorkflowIndexes, sweepWorkflows } from "../src/workflows";

const at = (msAgo = 0) => new Date(Date.now() - msAgo);

async function setup() {
  const x = await freshDb();
  await ensureWorkflowIndexes(x.d);
  return x;
}
async function memory(d: any, over: any = {}) {
  const r = await d.collection("memories").insertOne({ teamId: TEAM, projectId: PROJECT, key: "D-12", kind: "decision", text: "Tiered token buckets", status: "active", version: 1, origin: "call",
    sourceRefs: [{ type: "call", callId: "call-1", utteranceIds: [] }], lock: { lockedAt: at(), participants: ["Priya"], lockedBy: "Priya", via: "human" }, ...over });
  return r.insertedId;
}
async function workflow(d: any, over: any = {}) {
  const r = await d.collection("workflows").insertOne({ teamId: TEAM, projectId: PROJECT, name: "Decision locked -> Slack + GitHub", trigger: "memory_locked",
    steps: [{ type: "post_slack" }, { type: "create_issue" }], enabled: true, enabledAt: at(60_000), createdAt: at(60_000), updatedAt: at(60_000), createdBy: "Priya", ...over });
  return r.insertedId;
}
const lockEvent = (d: any, memoryId: ObjectId, over: any = {}) =>
  d.collection("audit_events").insertOne({ teamId: TEAM, projectId: PROJECT, callId: "call-1", at: at(), type: "memory_locked", actor: "Priya", reason: "locked", ref: { memoryId, key: "D-12" }, ...over });

test("a lock fires the enabled workflow: one action per step with the shared idempotency key, and a run log", async () => {
  const { d, done } = await setup();
  try {
    const wf = await workflow(d); const mid = await memory(d); await lockEvent(d, mid);
    assert.equal(await sweepWorkflows(d), 1);
    const acts = await d.collection("actions").find().sort({ type: 1 }).toArray();
    assert.deepEqual(acts.map((a) => a.idempotencyKey), [`create_issue:call-1:${mid}:v1`, `post_slack:call-1:${mid}:v1`]);
    assert.ok(acts.every((a) => a.status === "queued" && a.requestedBy === "Priya" && String(a.workflowId) === String(wf)));
    assert.match(acts[0].payload.title, /^D-12: Tiered/);
    const runs = await d.collection("workflow_runs").find().toArray();
    assert.equal(runs.length, 1); assert.equal(runs[0].status, "fired"); assert.equal(runs[0].memoryKey, "D-12");
    assert.deepEqual(runs[0].steps.map((s: any) => [s.type, s.duplicate]), [["post_slack", false], ["create_issue", false]]);
    assert.ok(runs[0].steps.every((s: any) => s.actionId instanceof ObjectId));
    assert.equal(await sweepWorkflows(d), 0, "a second sweep fires nothing");
    assert.equal(await d.collection("actions").countDocuments(), 2);
  } finally { await done(); }
});

test("a manual or voice send that already queued the same version is reused, never sent twice", async () => {
  const { d, done } = await setup();
  try {
    await workflow(d); const mid = await memory(d);
    await d.collection("actions").insertOne({ idempotencyKey: `post_slack:call-1:${mid}:v1`, type: "post_slack", status: "sent", teamId: TEAM, projectId: PROJECT, callId: "call-1", requestedBy: "Priya", payload: {} });
    await lockEvent(d, mid); await sweepWorkflows(d);
    assert.equal(await d.collection("actions").countDocuments({ type: "post_slack" }), 1);
    const run: any = await d.collection("workflow_runs").findOne();
    assert.deepEqual(run.steps.map((s: any) => [s.type, s.duplicate]), [["post_slack", true], ["create_issue", false]]);
  } finally { await done(); }
});

test("nothing fires for a disabled workflow, another team, a non-call memory, or an event older than enabledAt", async () => {
  const { d, done } = await setup();
  try {
    await workflow(d, { enabled: false });
    await workflow(d, { teamId: "orion-payments" });
    await workflow(d, { name: "late", enabledAt: at(-60_000) }); // enabled after the event
    const mid = await memory(d); await lockEvent(d, mid);
    assert.equal(await sweepWorkflows(d), 0);
    assert.equal(await d.collection("actions").countDocuments(), 0);
    assert.equal(await d.collection("workflow_runs").countDocuments(), 0);
  } finally { await done(); }
});

test("a lock on a non-call memory sends nothing and is logged as skipped with the reason", async () => {
  const { d, done } = await setup();
  try {
    await workflow(d, { name: "docs" });
    const docMem = await memory(d, { origin: "doc", key: "R-12" }); await lockEvent(d, docMem);
    assert.equal(await sweepWorkflows(d), 0);
    assert.equal(await d.collection("actions").countDocuments(), 0);
    const runs = await d.collection("workflow_runs").find().toArray();
    assert.deepEqual(runs.map((r) => [r.workflowName, r.status]), [["docs", "skipped"]]);
    assert.match(runs[0].note, /not a call decision/);
    assert.equal(await sweepWorkflows(d), 0); assert.equal(await d.collection("workflow_runs").countDocuments(), 1, "logged once");
  } finally { await done(); }
});

test("a correction fires memory_corrected workflows for the NEW version; callId comes from the memory when the event lacks it", async () => {
  const { d, done } = await setup();
  try {
    await workflow(d, { trigger: "memory_corrected", steps: [{ type: "post_slack" }] });
    const old = await memory(d, { status: "superseded" }); const v2 = await memory(d, { version: 2, supersedes: old });
    await d.collection("audit_events").insertOne({ teamId: TEAM, projectId: PROJECT, at: at(), type: "memory_corrected", actor: "Priya", reason: "fix", ref: { memoryId: String(old), newMemoryId: String(v2) } });
    assert.equal(await sweepWorkflows(d), 1);
    const a: any = await d.collection("actions").findOne();
    assert.equal(a.idempotencyKey, `post_slack:call-1:${v2}:v2`);
  } finally { await done(); }
});
