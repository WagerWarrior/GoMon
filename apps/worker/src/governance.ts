/**
 * Memory governance for voice/agent paths. Same rules as apps/web/lib/governance.ts (Max) and apps/connectors/src/policy.ts:
 * default-deny policy check (role from members, rule from policies), then ONE transaction that changes the record and writes
 * its audit_events row. Kept as a worker-local copy so the worker has no dependency on the Next app.
 */
import { ObjectId, type ClientSession, type MongoClient } from "mongodb";
import type { Cols } from "./db.ts";
import { loadPeople, peopleIn } from "./people.ts";
import { writeAdr } from "./knowledge.ts";
import type { AuditEvent, CallItem, GithubOp, ItemKind, Memory } from "./shapes.ts";

/** `voiceId` is the call's agent-template voice, stamped onto every `says` row written with this context. */
export type Ctx = { client: MongoClient; c: Cols; teamId: string; projectId: string; voiceId?: string };
export type PolicyResult = { allowed: boolean; reason: string; policyId?: string; checkedAt: Date };
export class PolicyDenied extends Error {
  constructor(public result: PolicyResult) { super(result.reason); }
}

export async function checkPolicy(ctx: Ctx, actor: string, action: string): Promise<PolicyResult> {
  const checkedAt = new Date();
  const member = await ctx.c.members.findOne({ teamId: ctx.teamId, displayName: actor });
  if (!member) return { allowed: false, reason: `unknown member "${actor}"`, checkedAt };
  const policy = await ctx.c.policies.findOne({ teamId: ctx.teamId, action, $or: [{ projectId: ctx.projectId }, { projectId: { $exists: false } }] });
  if (!policy) return { allowed: false, reason: `no policy for ${action}`, checkedAt };
  const roles = policy.allowedRoles as string[];
  const ok = roles.includes(member.role as string);
  return { allowed: ok, reason: ok ? `role ${member.role} may ${action}` : `role ${member.role} may not ${action}`, policyId: String(policy._id), checkedAt };
}

export async function audit(ctx: Ctx, e: Omit<AuditEvent, "teamId" | "projectId" | "at">, session?: ClientSession) {
  await ctx.c.auditEvents.insertOne({ teamId: ctx.teamId, projectId: ctx.projectId, at: new Date(), ...e }, { session });
}

/** Policy check that audits a denial and throws PolicyDenied (callers speak or return the reason). */
export async function gate(ctx: Ctx, actor: string, action: string, callId?: string, ref?: Record<string, unknown>) {
  const result = await checkPolicy(ctx, actor, action);
  if (!result.allowed) {
    await audit(ctx, { callId, type: "policy_denied", actor, reason: result.reason, ref: { action, ...ref } });
    throw new PolicyDenied(result);
  }
  return result;
}

export const PREFIX: Record<ItemKind, string> = {
  decision: "D", requirement: "R", constraint: "C", risk: "K", open_question: "Q", action: "T", assumption: "A", interface: "I", alternative: "L",
};

/**
 * Next human-readable key for a kind (D-12, R-16 …). Keys are unique per TEAM across projects (a spoken key names one memory),
 * so the counter is `${teamId}/${prefix}` and its first value continues after the highest key anywhere in the team.
 */
async function nextKey(ctx: Ctx, kind: ItemKind, session: ClientSession): Promise<string> {
  const p = PREFIX[kind];
  const id = `${ctx.teamId}/${p}`;
  let row = await ctx.c.counters.findOneAndUpdate({ _id: id }, { $inc: { n: 1 } }, { session, returnDocument: "after" });
  if (!row) {
    const existing = await ctx.c.memories.find({ teamId: ctx.teamId, key: { $regex: `^${p}-\\d+$` } }, { session, projection: { key: 1 } }).toArray();
    const max = existing.reduce((m, d) => Math.max(m, Number(d.key?.split("-")[1] ?? 0)), 0);
    row = await ctx.c.counters.findOneAndUpdate({ _id: id }, { $setOnInsert: { n: max + 1 } }, { session, upsert: true, returnDocument: "after" });
  }
  return `${p}-${String(row!.n).padStart(2, "0")}`;
}

/**
 * Consensus lock: promote a call item to canonical memory. One transaction: item must still be `locking` (a veto in the
 * meantime wins), memory inserted with lock proof (the validator requires it), item promoted with its TTL cleared, audit row.
 */
export async function promoteItem(ctx: Ctx, itemId: ObjectId, actor: string, via: "consensus" | "voice" | "human"): Promise<Memory | null> {
  const item = await ctx.c.callItems.findOne({ _id: itemId });
  if (!item) return null;
  await gate(ctx, actor, "lock_decision", item.callId, { itemId });
  const call = await ctx.c.calls.findOne({ _id: item.callId as never });
  const participants = [...new Set([...(call?.participants as string[] | undefined ?? []), ...(item.agreedBy ?? []), actor])];
  let promoted: Memory | null = null;
  await ctx.client.withSession((session) => session.withTransaction(async () => {
    const now = new Date();
    const claimed = await ctx.c.callItems.findOneAndUpdate(
      { _id: itemId, status: { $in: via === "consensus" ? ["locking"] : ["proposed", "locking"] } },
      { $set: { status: "promoted", updatedAt: now }, $unset: { expiresAt: "", lockAnnouncedAt: "" } },
      { session, returnDocument: "after" },
    );
    if (!claimed) return;
    const mem: Memory = {
      teamId: ctx.teamId, projectId: ctx.projectId, key: await nextKey(ctx, item.kind, session), kind: item.kind, text: item.text,
      status: "active", version: 1, origin: "call",
      sourceRefs: [{ type: "call", callId: item.callId, itemId, utteranceIds: item.sourceUtteranceIds }],
      lock: { lockedAt: now, participants, lockedBy: actor, via }, createdAt: now, updatedAt: now,
    };
    const { insertedId } = await ctx.c.memories.insertOne(mem, { session });
    await ctx.c.callItems.updateOne({ _id: itemId }, { $set: { memoryId: insertedId } }, { session });
    await audit(ctx, { callId: item.callId, type: "memory_locked", actor, reason: `locked via ${via}`, ref: { itemId, memoryId: insertedId, key: mem.key } }, session);
    promoted = { ...mem, _id: insertedId };
  }));
  // The transaction callback assigns `promoted`; TS can't see that, so widen it back before reading.
  const result = promoted as Memory | null;
  // ADR artifact (embedded by Atlas) for every locked decision; outside the transaction so a slow write never blocks the lock.
  if (result?._id) await writeAdr(ctx.c, { ...result, _id: result._id }).catch((e) => console.error("[adr]", e instanceof Error ? e.message : e));
  return result;
}

/** A spoken "wait" during the veto window returns locking items to proposed. */
export async function vetoLocks(ctx: Ctx, callId: string, actor: string): Promise<CallItem[]> {
  const locking = await ctx.c.callItems.find({ callId, status: "locking" }).toArray();
  const vetoed: CallItem[] = [];
  for (const it of locking) {
    await ctx.client.withSession((session) => session.withTransaction(async () => {
      const r = await ctx.c.callItems.updateOne({ _id: it._id, status: "locking" }, { $set: { status: "proposed", updatedAt: new Date() }, $unset: { lockAnnouncedAt: "", vetoMs: "" } }, { session });
      if (r.modifiedCount) {
        await audit(ctx, { callId, type: "lock_vetoed", actor, reason: "objection during veto window", ref: { itemId: it._id } }, session);
        vetoed.push(it);
      }
    }));
  }
  return vetoed;
}

/** Correct = supersede with history: the old version leaves the active set in the same transaction the new one enters it. */
export async function correctMemory(ctx: Ctx, memoryId: ObjectId, newText: string, actor: string, callId?: string): Promise<Memory | null> {
  await gate(ctx, actor, "correct_memory", callId, { memoryId });
  let next: Memory | null = null;
  await ctx.client.withSession((session) => session.withTransaction(async () => {
    const old = await ctx.c.memories.findOne({ _id: memoryId, teamId: ctx.teamId, projectId: ctx.projectId, status: "active" }, { session });
    if (!old) return;
    const now = new Date();
    const { _id: oldId, ...rest } = old;
    const doc: Memory = {
      ...rest, text: newText, version: old.version + 1, supersedes: oldId, status: "active", updatedAt: now, createdAt: now,
      sourceRefs: callId ? [...old.sourceRefs, { type: "call", callId, utteranceIds: [] }] : old.sourceRefs,
      ...(old.origin === "call" ? { lock: { lockedAt: now, participants: [...new Set([...(old.lock?.participants ?? []), actor])], lockedBy: actor, via: "voice" as const } } : {}),
    };
    delete doc.supersededBy;
    const { insertedId } = await ctx.c.memories.insertOne(doc, { session });
    await ctx.c.memories.updateOne({ _id: oldId }, { $set: { status: "superseded", supersededBy: insertedId, updatedAt: now } }, { session });
    await audit(ctx, { callId, type: "memory_corrected", actor, reason: `v${old.version} -> v${doc.version}`, ref: { memoryId: oldId, newMemoryId: insertedId, key: old.key } }, session);
    next = { ...doc, _id: insertedId };
  }));
  return next;
}

/** Forget = tombstone with history: leaves retrieval immediately (every query filters status: "active"). */
export async function forgetMemory(ctx: Ctx, memoryId: ObjectId, actor: string, callId?: string): Promise<Memory | null> {
  await gate(ctx, actor, "forget_memory", callId, { memoryId });
  let forgotten: Memory | null = null;
  await ctx.client.withSession((session) => session.withTransaction(async () => {
    const now = new Date();
    const doc = await ctx.c.memories.findOneAndUpdate(
      { _id: memoryId, teamId: ctx.teamId, projectId: ctx.projectId, status: "active" },
      { $set: { status: "forgotten", forgottenAt: now, forgottenBy: actor, updatedAt: now } },
      { session, returnDocument: "after" },
    );
    if (!doc) return;
    await audit(ctx, { callId, type: "memory_forgotten", actor, reason: "forgotten on request", ref: { memoryId, key: doc.key } }, session);
    forgotten = doc;
  }));
  return forgotten;
}

/** Issue title/body/labels for a memory: one format for "create the tickets", workflows and a voice "file R-21". */
export function memoryIssue(m: Memory & { _id: ObjectId }, callId: string): { title: string; body: string; labels: string[] } {
  const origin = m.origin === "call" ? `Locked on call \`${callId}\` by ${m.lock?.participants?.join(", ") ?? "the team"}.` : "From team memory.";
  return { title: `${m.key ?? m.kind}: ${m.text.slice(0, 72)}`, body: `${m.text}\n\n${origin}\nMemory \`${m._id}\` v${m.version} (${m.key ?? m.kind}).`, labels: ["gomon", m.kind] };
}

/** Words long enough to tie an action item to the decision it implements ("Max wires the burst limiter" ~ "burst limiter"). */
const contentWords = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{5,}/g) ?? []);

/**
 * External effects only enqueue to the outbox; apps/connectors does the policy check and the send. The idempotency key is
 * `${type}:${callId}:${memoryId}:v${version}` (agreed with apps/web) so voice and UI never file the same decision version twice.
 * Issues are assigned to people the decision names (or an action item on this call that names them and shares its subject),
 * and go onto the call project's GitHub board when it has one.
 */
export async function enqueueForCall(ctx: Ctx, type: "create_issue" | "post_slack", callId: string, actor: string): Promise<{ queued: number; existing: number; assigned: string[] }> {
  const mems = await ctx.c.memories.find({ teamId: ctx.teamId, projectId: ctx.projectId, status: "active", origin: "call", "sourceRefs.callId": callId }).toArray();
  const [people, actionItems, project] = type === "create_issue" && mems.length
    ? await Promise.all([
      loadPeople(ctx),
      ctx.c.callItems.find({ callId, kind: "action" }, { projection: { text: 1 } }).toArray(),
      ctx.c.projects.findOne({ _id: ctx.projectId as never, teamId: ctx.teamId }, { projection: { github: 1 } }),
    ])
    : [[], [], null];
  let queued = 0, existing = 0;
  const assigned = new Set<string>();
  for (const m of mems) {
    const idempotencyKey = `${type}:${callId}:${m._id}:v${m.version}`;
    let payload: Record<string, unknown>;
    if (type === "create_issue") {
      const words = contentWords(m.text);
      const linked = actionItems.filter((i) => [...contentWords(i.text)].filter((w) => words.has(w)).length >= 2).map((i) => i.text);
      const owners = [...new Map([m.text, ...linked].flatMap((t) => peopleIn(t, people)).map((p) => [p.login, p])).values()];
      owners.forEach((p) => assigned.add(p.display));
      payload = { ...memoryIssue(m, callId), assignees: owners.map((p) => p.login), ...(project?.github?.projectId ? { project: ctx.projectId } : {}) };
    } else payload = { text: `Decision locked (${m.key ?? m.kind}): ${m.text}`, callId, memoryId: String(m._id) };
    const r = await ctx.c.actions.updateOne(
      { idempotencyKey },
      { $setOnInsert: { idempotencyKey, callId, teamId: ctx.teamId, projectId: ctx.projectId, type, payload, requestedBy: actor, status: "queued", attempts: 0, createdAt: new Date(), memoryId: m._id, announce: true } },
      { upsert: true },
    );
    if (r.upsertedCount) {
      queued++;
      await audit(ctx, { callId, type: "action_enqueued", actor, reason: type, ref: { idempotencyKey, memoryId: m._id } });
    } else existing++;
  }
  return { queued, existing, assigned: [...assigned] };
}

/** Deterministic key for a voice GitHub request: the same utterance can never enqueue the same op twice. */
export function githubKey(callId: string, utteranceId: ObjectId | string, op: GithubOp, n: number): string {
  return `github:${callId}:${utteranceId}:${op}:${n}`;
}

/**
 * Enqueue one GitHub op (contract 6) after a worker-side policy check, so a denial is spoken at once; apps/connectors checks
 * again before sending. `announce` makes the announcer speak the result on the call. Returns false if the key already existed.
 */
export async function enqueueGithub(
  ctx: Ctx, callId: string | undefined, actor: string, op: GithubOp, args: Record<string, unknown>, idempotencyKey: string,
  extra: { memoryId?: ObjectId; announce?: boolean } = {},
): Promise<boolean> {
  await gate(ctx, actor, op === "create_project" ? "create_project" : "github_write", callId, { op, idempotencyKey });
  const r = await ctx.c.actions.updateOne(
    { idempotencyKey },
    {
      $setOnInsert: {
        type: "github", teamId: ctx.teamId, projectId: ctx.projectId, ...(callId ? { callId } : {}), payload: { op, ...args },
        requestedBy: actor, idempotencyKey, status: "queued", attempts: 0, createdAt: new Date(), announce: extra.announce ?? !!callId,
        ...(extra.memoryId ? { memoryId: extra.memoryId } : {}),
      },
    },
    { upsert: true },
  );
  if (r.upsertedCount) await audit(ctx, { callId, type: "action_enqueued", actor, reason: `github ${op}`, ref: { idempotencyKey, ...(extra.memoryId ? { memoryId: extra.memoryId } : {}) } });
  return r.upsertedCount > 0;
}

export function oid(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}
