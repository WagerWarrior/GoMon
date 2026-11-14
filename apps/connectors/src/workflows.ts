/**
 * Max (connectors): stored automation chains. A workflow says "when <trigger> happens, run these steps"
 * (e.g. memory_locked -> post_slack, create_issue). Steps only ENQUEUE outbox actions; the outbox still runs the policy
 * check (as the person whose action fired the trigger) and does the idempotent send. Keys are the same as the UI and the
 * voice agent (`type:callId:memoryId:vN`), so a workflow, a click and "Gomon, create the tickets" never double-send.
 *
 * workflows      { teamId, projectId, name, trigger, steps: [{ type }], enabled, enabledAt, createdAt, updatedAt, createdBy }
 * workflow_runs  { workflowId, workflowName, teamId, projectId, trigger, eventId, callId?, memoryId?, memoryKey?, actor,
 *                  firedAt, status: "fired"|"skipped", note?, steps: [{ type, actionId, idempotencyKey, duplicate }] }
 */
import { ObjectId, type Db } from "mongodb";

export const TRIGGERS = ["memory_locked", "memory_corrected"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const STEP_TYPES = ["post_slack", "create_issue"] as const;
export type StepType = (typeof STEP_TYPES)[number];

const WINDOW_MS = 15 * 60_000; // how far back a sweep looks for trigger events (restart catch-up)

export async function ensureWorkflowIndexes(d: Db) {
  await Promise.all([
    d.collection("workflow_runs").createIndex({ workflowId: 1, eventId: 1 }, { unique: true }),
    d.collection("workflow_runs").createIndex({ teamId: 1, projectId: 1, firedAt: -1 }),
    d.collection("workflows").createIndex({ teamId: 1, projectId: 1, trigger: 1, enabled: 1 }),
    d.collection("audit_events").createIndex({ type: 1, at: -1 }),
  ]);
}

const oid = (v: unknown) => (v instanceof ObjectId ? v : typeof v === "string" && ObjectId.isValid(v) ? new ObjectId(v) : null);

/** Same payload text as apps/web gov route and apps/worker enqueueForCall. */
function payload(type: StepType, m: any, callId: string) {
  const tag = m.key ?? m.kind;
  return type === "create_issue"
    ? { title: `${tag}: ${String(m.text).slice(0, 72)}`, body: `${m.text}\n\nLocked on call \`${callId}\` by ${m.lock?.participants?.join(", ") ?? "the team"}.\nMemory \`${m._id}\` v${m.version} (${tag}).`, labels: ["gomon", String(m.kind)] }
    : { text: `Decision locked (${tag}): ${m.text}`, callId, memoryId: String(m._id) };
}

/** Fire every due (workflow, event) pair once. Returns how many runs fired (skipped runs are logged, not counted). */
export async function sweepWorkflows(d: Db, now = new Date()): Promise<number> {
  const events = await d.collection("audit_events")
    .find({ type: { $in: [...TRIGGERS] }, at: { $gte: new Date(now.getTime() - WINDOW_MS) } }).sort({ at: 1 }).limit(200).toArray();
  if (!events.length) return 0;
  const flows = await d.collection("workflows").find({ enabled: true, trigger: { $in: [...TRIGGERS] } }).toArray();
  if (!flows.length) return 0;
  const done = new Set((await d.collection("workflow_runs")
    .find({ eventId: { $in: events.map((e) => e._id) } }, { projection: { workflowId: 1, eventId: 1 } }).toArray())
    .map((r) => `${r.workflowId}:${r.eventId}`));
  let fired = 0;
  for (const ev of events) {
    const due = flows.filter((w) => w.trigger === ev.type && w.teamId === ev.teamId && w.projectId === ev.projectId
      && (w.enabledAt ?? w.createdAt) <= ev.at && !done.has(`${w._id}:${ev._id}`));
    for (const w of due) if (await fire(d, w, ev)) fired++;
  }
  return fired;
}

async function fire(d: Db, w: any, ev: any): Promise<boolean> {
  const memoryId = oid(ev.type === "memory_corrected" ? ev.ref?.newMemoryId : ev.ref?.memoryId);
  const m: any = memoryId ? await d.collection("memories").findOne({ _id: memoryId, teamId: w.teamId, projectId: w.projectId }) : null;
  const callId: string | undefined = ev.callId ?? m?.sourceRefs?.find((s: any) => s.type === "call" && s.callId)?.callId;
  const base = { workflowId: w._id, workflowName: w.name, teamId: w.teamId, projectId: w.projectId, trigger: ev.type, eventId: ev._id,
    callId, memoryId: m?._id, memoryKey: m?.key, actor: ev.actor, firedAt: new Date() };
  const skip = m?.origin !== "call" ? "not a call decision" : m.status !== "active" ? `memory is ${m.status}` : !callId ? "no call to file it under" : null;
  if (!m || skip) {
    await d.collection("workflow_runs").insertOne({ ...base, status: "skipped", note: m ? skip : "memory not found", steps: [] }).catch(dupOk);
    return false;
  }
  // Actions first (idempotent upserts), then the run row; a crash in between just re-fires into the same actions.
  const steps = [];
  for (const s of w.steps as { type: StepType }[]) {
    if (!STEP_TYPES.includes(s.type)) continue;
    const idempotencyKey = `${s.type}:${callId}:${m._id}:v${m.version}`;
    const r = await d.collection("actions").findOneAndUpdate(
      { idempotencyKey },
      { $setOnInsert: { idempotencyKey, type: s.type, callId, teamId: w.teamId, projectId: w.projectId, memoryId: m._id, payload: payload(s.type, m, callId!),
          requestedBy: ev.actor, status: "queued", attempts: 0, createdAt: new Date(), workflowId: w._id, via: "workflow" } },
      { upsert: true, returnDocument: "after", includeResultMetadata: true },
    );
    steps.push({ type: s.type, actionId: r.value?._id, idempotencyKey, duplicate: !r.lastErrorObject?.upserted });
  }
  const ins = await d.collection("workflow_runs").insertOne({ ...base, status: "fired", steps }).then(() => true, dupOk);
  if (ins) await d.collection("audit_events").insertOne({ teamId: w.teamId, projectId: w.projectId, callId, at: new Date(), type: "workflow_fired", actor: ev.actor,
    reason: w.name, ref: { workflowId: w._id, eventId: ev._id, memoryId: m._id, key: m.key, steps: steps.map((s) => `${s.type}${s.duplicate ? " (already queued)" : ""}`) } });
  return !!ins;
}

function dupOk(e: any): false { if (e?.code === 11000) return false; throw e; }

/** The default chain for the demo team: a locked decision goes to the Slack thread and becomes a GitHub issue. */
export async function seedDefaultWorkflow(d: Db, scope: { teamId: string; projectId: string }, createdBy = "Max") {
  const now = new Date();
  return d.collection("workflows").updateOne(
    { teamId: scope.teamId, projectId: scope.projectId, name: "Decision locked -> Slack + GitHub" },
    { $setOnInsert: { ...scope, name: "Decision locked -> Slack + GitHub", trigger: "memory_locked", steps: [{ type: "post_slack" }, { type: "create_issue" }],
        enabled: true, enabledAt: now, createdAt: now, updatedAt: now, createdBy } },
    { upsert: true },
  );
}
