/**
 * Outbox processing (spec sections 6-7). The agent and the workspace only WRITE actions; this is the only code that
 * touches GitHub or Slack. For each action: claim atomically -> policy check -> send -> record the external ID.
 *
 * Rules enforced here:
 *  - nothing is sent without a passing, recorded policy check
 *  - an action is not "sent" until its external ID is stored (one update sets both)
 *  - a retry first looks for the earlier attempt's side effect (marker/metadata) and adopts it instead of sending again
 *  - permanent errors stop; transient ones back off
 */
import type { Db } from "mongodb";
import { checkPolicy } from "./policy";
import * as github from "./github";
import * as slack from "./slack";
import { Permanent, Retryable, type Action, type Env, type Sent } from "./types";

export const MAX_ATTEMPTS = 5;
const POLICY_FOR: Record<string, string> = { create_issue: "create_issue", post_slack: "post_slack" };
const chains = new Map<string, Promise<unknown>>();
/** Serialize per call so a Slack thread root is only created once. */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next.catch(() => {}));
  return next;
}

const audit = (d: Db, a: Action, type: string, reason: string, ref: Record<string, unknown> = {}) =>
  d.collection("audit_events").insertOne({ callId: a.callId, teamId: a.teamId, projectId: a.projectId, at: new Date(), type, actor: "connector", reason, ref: { actionId: String(a._id), ...ref } });

export type Outcome = "sent" | "denied" | "failed" | "requeued" | "skipped";

export async function processAction(d: Db, id: any, env: Env): Promise<Outcome> {
  const col = d.collection<Action>("actions");
  // Atomic claim: two workers (or a replayed change event) can never both send.
  const a = await col.findOneAndUpdate({ _id: id, status: "queued" }, { $set: { status: "sending", updatedAt: new Date() }, $inc: { attempts: 1 } }, { returnDocument: "after" });
  if (!a) return "skipped";

  const policy = await checkPolicy(d, a.teamId, a.projectId, a.requestedBy, POLICY_FOR[a.type] ?? a.type);
  if (!policy.allowed) {
    await col.updateOne({ _id: a._id }, { $set: { status: "denied", policyCheck: policy, updatedAt: new Date() } });
    await audit(d, a, "action_denied", policy.reason);
    return "denied";
  }
  await col.updateOne({ _id: a._id }, { $set: { policyCheck: policy } });

  try {
    const sent = await serial(`${a.teamId}:${a.callId ?? a._id}`, () => send(d, a, env));
    // One update sets status and externalId together: "sent" never exists without its external ID.
    const r = await col.updateOne({ _id: a._id, status: "sending" }, { $set: { status: "sent", externalId: sent.externalId, ...(sent.externalUrl ? { externalUrl: sent.externalUrl } : {}), sentAt: new Date(), updatedAt: new Date(), ...(sent.note ? { note: sent.note } : {}) }, $unset: { error: "", nextAttemptAt: "" } });
    if (r.modifiedCount === 1) await audit(d, a, "action_sent", `${a.type} -> ${sent.externalId}`, { externalId: sent.externalId, policyId: policy.policyId });
    await confirm(d, a, sent, env);
    return "sent";
  } catch (e: any) {
    if (e instanceof Permanent || (e instanceof Retryable && (a.attempts ?? 1) >= MAX_ATTEMPTS)) {
      await col.updateOne({ _id: a._id }, { $set: { status: "failed", error: String(e.message), updatedAt: new Date() } });
      await audit(d, a, "action_failed", String(e.message));
      return "failed";
    }
    const wait = e instanceof Retryable && e.retryAfterMs ? e.retryAfterMs : Math.min(60000, 1000 * 2 ** (a.attempts ?? 1));
    await col.updateOne({ _id: a._id }, { $set: { status: "queued", error: String(e.message), nextAttemptAt: new Date(Date.now() + wait), updatedAt: new Date() } });
    await audit(d, a, "action_retry_scheduled", String(e.message), { inMs: wait });
    return "requeued";
  }
}

async function send(d: Db, a: Action, env: Env): Promise<Sent> {
  if (a.type === "create_issue") {
    if ((a.attempts ?? 1) > 1) { const prior = await github.findIssue(env, a.idempotencyKey); if (prior) return { ...prior, note: "adopted earlier attempt" }; }
    return github.createIssue(env, a.payload, a.idempotencyKey);
  }
  if (a.type === "post_slack") {
    const calls = d.collection("calls");
    const call: any = a.callId ? await calls.findOne({ _id: a.callId as any }) : null;
    // A thread lives in one channel; if SLACK_CHANNEL_ID changed since the call's thread was started, start a new one here.
    const here = (c: any) => !!c?.slackThreadTs && (!c.slackRootId || String(c.slackRootId).startsWith(`${env.SLACK_CHANNEL_ID}:`));
    let thread: string | undefined = here(call) ? call.slackThreadTs : undefined;
    if ((a.attempts ?? 1) > 1) { const prior = await slack.findMessage(env, a.idempotencyKey, thread); if (prior) return { ...prior, note: "adopted earlier attempt" }; }
    if (!thread && a.callId) { // thread per call: the first post becomes the root
      const root = await slack.postMessage(env, `Gomon design call: ${call?.title ?? a.callId}`, `root:${a.callId}`);
      const notHere = { $or: [{ slackThreadTs: { $exists: false } }, { slackRootId: { $not: new RegExp(`^${env.SLACK_CHANNEL_ID}:`) } }] };
      const upd = await calls.findOneAndUpdate({ _id: a.callId as any, ...notHere }, { $set: { slackThreadTs: root.ts, slackRootId: root.externalId } }, { returnDocument: "after" });
      thread = (upd as any)?.slackThreadTs ?? (await calls.findOne({ _id: a.callId as any }) as any)?.slackThreadTs ?? root.ts;
    }
    const m = await slack.postMessage(env, String(a.payload.text ?? ""), a.idempotencyKey, thread);
    return { externalId: m.externalId, note: thread ? `thread ${thread}` : undefined };
  }
  throw new Permanent(`unknown action type ${a.type}`);
}

/** Best-effort read-back. A failure here never un-sends; it only withholds the "confirmed" upgrade. */
async function confirm(d: Db, a: Action, sent: Sent, env: Env) {
  try {
    let seen = false;
    if (a.type === "create_issue") seen = await github.confirmIssue(env, sent.externalId, a.idempotencyKey);
    else if (a.type === "post_slack") {
      const call: any = await d.collection("calls").findOne({ _id: a.callId as any });
      const hit = await slack.findMessage(env, a.idempotencyKey, call?.slackThreadTs);
      seen = hit?.externalId === sent.externalId;
    }
    if (seen) await d.collection("actions").updateOne({ _id: a._id, status: "sent" }, { $set: { status: "confirmed", confirmedAt: new Date() } });
  } catch { /* leave as sent */ }
}

/** Actions to work on now: queued and due, plus "sending" claims stuck longer than the timeout (worker died mid-send). */
export async function dueActionIds(d: Db, stuckAfterMs = 60000): Promise<any[]> {
  const now = new Date();
  const col = d.collection<Action>("actions");
  await col.updateMany({ status: "sending", updatedAt: { $lt: new Date(Date.now() - stuckAfterMs) } }, { $set: { status: "queued", error: "worker died mid-send; will look for an earlier side effect first" } });
  const docs = await col.find({ status: "queued", $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(50).toArray();
  return docs.map((x) => x._id);
}
