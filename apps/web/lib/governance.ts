/**
 * Human governance actions from the workspace. They obey the SAME rules as voice (spec section 5):
 * policy check first, then one transaction that changes the record and writes its audit event together.
 * Atlas validators (Rob) are the last line; this module never bypasses them.
 */
import { ObjectId, type ClientSession, type Db, type MongoClient } from "mongodb";
import type { ActionType, CallDoc } from "./types";

export type PolicyResult = { allowed: boolean; reason: string; policyId?: string; checkedAt: Date };

/** Default-deny. Role comes from members (displayName <-> meeting identity); rule from policies. */
export async function checkPolicy(d: Db, teamId: string, projectId: string, actor: string, action: string): Promise<PolicyResult> {
  const checkedAt = new Date();
  const member = await d.collection("members").findOne({ teamId, displayName: actor });
  if (!member) return { allowed: false, reason: `unknown member "${actor}"`, checkedAt };
  const policy = await d.collection("policies").findOne({ teamId, action, $or: [{ projectId }, { projectId: { $exists: false } }] });
  if (!policy) return { allowed: false, reason: `no policy for ${action}`, checkedAt };
  const ok = (policy.allowedRoles as string[]).includes(member.role as string);
  return { allowed: ok, reason: ok ? `role ${member.role} may ${action}` : `role ${member.role} may not ${action}`, policyId: String(policy._id), checkedAt };
}

export class PolicyDenied extends Error { constructor(public result: PolicyResult) { super(result.reason); } }
export class NotFound extends Error {}

async function tx<T>(c: MongoClient, fn: (s: ClientSession) => Promise<T>): Promise<T> {
  const s = c.startSession();
  try { let out!: T; await s.withTransaction(async () => { out = await fn(s); }); return out; } finally { await s.endSession(); }
}

const oid = (id: string) => new ObjectId(id);

type Ctx = { c: MongoClient; d: Db; teamId: string; projectId: string };

function audit(ctx: Ctx, callId: string | undefined, type: string, actor: string, reason: string, ref: Record<string, unknown>) {
  return { callId, teamId: ctx.teamId, projectId: ctx.projectId, at: new Date(), type, actor, reason, ref };
}

/** Promote a call item to canonical memory: item -> promoted, memory inserted, TTL cleared, audit written; one transaction. */
export async function lockItem(ctx: Ctx, itemId: string, actor: string) {
  const policy = await checkPolicy(ctx.d, ctx.teamId, ctx.projectId, actor, "lock_decision");
  if (!policy.allowed) { await ctx.d.collection("audit_events").insertOne(audit(ctx, undefined, "lock_denied", actor, policy.reason, { itemId })); throw new PolicyDenied(policy); }
  return tx(ctx.c, async (session) => {
    const items = ctx.d.collection("call_items");
    const item = await items.findOne({ _id: oid(itemId) }, { session });
    if (!item) throw new NotFound("item");
    if (item.status === "promoted") return { memoryId: String(item.memoryId ?? ""), already: true };
    const call = (await ctx.d.collection<CallDoc>("calls").findOne({ _id: item.callId }, { session })) as CallDoc | null;
    const participants = call?.participants?.length ? call.participants : [actor];
    const mem = {
      teamId: ctx.teamId, projectId: ctx.projectId, kind: item.kind, text: item.text, status: "active", version: 1, supersedes: null,
      origin: "call", sourceRefs: [{ type: "call_item", id: String(item._id), utteranceIds: (item.sourceUtteranceIds ?? []).map(String), callId: item.callId }],
      lock: { lockedAt: new Date(), participants, lockedBy: actor, via: "workspace" }, createdAt: new Date(),
    };
    const { insertedId } = await ctx.d.collection("memories").insertOne(mem, { session });
    await items.updateOne({ _id: item._id }, { $set: { status: "promoted", memoryId: insertedId }, $unset: { expiresAt: "" } }, { session });
    await ctx.d.collection("audit_events").insertOne(audit(ctx, item.callId, "memory_promoted", actor, `locked via workspace (${policy.reason})`, { itemId, memoryId: String(insertedId) }), { session });
    return { memoryId: String(insertedId), already: false };
  });
}

export async function rejectItem(ctx: Ctx, itemId: string, actor: string) {
  return tx(ctx.c, async (session) => {
    const items = ctx.d.collection("call_items");
    const item = await items.findOne({ _id: oid(itemId) }, { session });
    if (!item) throw new NotFound("item");
    if (item.status === "promoted") throw new Error("already promoted; use correct or forget on the memory");
    await items.updateOne({ _id: item._id }, { $set: { status: "rejected", rejectedBy: actor } }, { session });
    await ctx.d.collection("audit_events").insertOne(audit(ctx, item.callId, "item_rejected", actor, "rejected in workspace", { itemId }), { session });
    return { ok: true };
  });
}

/** Supersede: old memory leaves retrieval immediately (status superseded), new version is active with history links. */
export async function correctMemory(ctx: Ctx, memoryId: string, newText: string, actor: string) {
  const policy = await checkPolicy(ctx.d, ctx.teamId, ctx.projectId, actor, "lock_decision");
  if (!policy.allowed) { await ctx.d.collection("audit_events").insertOne(audit(ctx, undefined, "correct_denied", actor, policy.reason, { memoryId })); throw new PolicyDenied(policy); }
  return tx(ctx.c, async (session) => {
    const mems = ctx.d.collection("memories");
    const old = await mems.findOne({ _id: oid(memoryId), teamId: ctx.teamId, projectId: ctx.projectId }, { session });
    if (!old) throw new NotFound("memory");
    if (old.status !== "active") throw new Error(`memory is ${old.status}; only active memories can be corrected`);
    const next = {
      ...old, _id: undefined, text: newText, version: (old.version ?? 1) + 1, supersedes: old._id, status: "active", createdAt: new Date(),
      lock: { ...(old.lock ?? {}), lockedAt: new Date(), lockedBy: actor, via: "workspace-correction", participants: old.lock?.participants?.length ? old.lock.participants : [actor] },
    } as Record<string, unknown>;
    delete next._id;
    delete next.embedding; delete next.embeddingModel; // the old vector describes the old text; re-embed the new one
    const { insertedId } = await mems.insertOne(next, { session });
    await mems.updateOne({ _id: old._id }, { $set: { status: "superseded", supersededBy: insertedId, supersededAt: new Date() } }, { session });
    await ctx.d.collection("audit_events").insertOne(audit(ctx, undefined, "memory_corrected", actor, "corrected in workspace", { memoryId, newMemoryId: String(insertedId), from: old.text, to: newText }), { session });
    return { memoryId: String(insertedId) };
  });
}

/** Tombstone: memory leaves retrieval immediately; history stays queryable. */
export async function forgetMemory(ctx: Ctx, memoryId: string, actor: string) {
  const policy = await checkPolicy(ctx.d, ctx.teamId, ctx.projectId, actor, "forget_memory");
  if (!policy.allowed) { await ctx.d.collection("audit_events").insertOne(audit(ctx, undefined, "forget_denied", actor, policy.reason, { memoryId })); throw new PolicyDenied(policy); }
  return tx(ctx.c, async (session) => {
    const mems = ctx.d.collection("memories");
    const m = await mems.findOne({ _id: oid(memoryId), teamId: ctx.teamId, projectId: ctx.projectId }, { session });
    if (!m) throw new NotFound("memory");
    await mems.updateOne({ _id: m._id }, { $set: { status: "forgotten", forgottenAt: new Date(), forgottenBy: actor } }, { session });
    await ctx.d.collection("audit_events").insertOne(audit(ctx, undefined, "memory_forgotten", actor, "forgotten in workspace", { memoryId, text: m.text }), { session });
    return { ok: true };
  });
}

/**
 * Write to the outbox only. The connector worker owns policy check + external send + externalId.
 * Deterministic idempotency key: a double click or a retry resolves to the same action, never a second one.
 */
export async function enqueueAction(ctx: Ctx, type: ActionType, payload: Record<string, unknown>, requestedBy: string, callId: string, dedupeOn: string) {
  const idempotencyKey = `${type}:${callId}:${dedupeOn}`;
  const col = ctx.d.collection("actions");
  const doc = { callId, teamId: ctx.teamId, projectId: ctx.projectId, type, payload, requestedBy, status: "queued", idempotencyKey, attempts: 0, createdAt: new Date() };
  try {
    const r = await col.insertOne(doc);
    await ctx.d.collection("audit_events").insertOne(audit(ctx, callId, "action_requested", requestedBy, `${type} requested from workspace`, { actionId: String(r.insertedId), idempotencyKey }));
    return { actionId: String(r.insertedId), duplicate: false };
  } catch (e: any) {
    if (e?.code === 11000) { const ex = await col.findOne({ idempotencyKey }); return { actionId: String(ex?._id), duplicate: true }; }
    throw e;
  }
}
