/** Dev: dump what Gomon wrote for a call (items, conflicts, says, memories, actions, audit, timings). npm run inspect -- <callId> */
import { close, cols, connect } from "../src/db.ts";
const { db } = await connect(); const c = cols(db); const callId = process.argv[2];
const p = (t: string, x: unknown) => console.log(`\n== ${t}\n` + JSON.stringify(x, null, 0).replace(/},{/g, "},\n{"));
p("call_items", (await c.callItems.find({ callId }).sort({ createdAt: 1 }).toArray()).map((i) => ({ kind: i.kind, status: i.status, text: i.text, mem: i.memoryId })));
p("conflicts", (await c.conflicts.find({ callId }).toArray()).map((x) => ({ key: x.memoryKey, sev: x.severity, kind: x.kind, spoken: x.spoken, note: x.note })));
p("says", (await c.says.find({ callId }).sort({ createdAt: 1 }).toArray()).map((s) => ({ reason: s.reason, text: s.text })));
p("memories from call", (await c.memories.find({ origin: "call", "sourceRefs.callId": callId }).toArray()).map((m) => ({ key: m.key, status: m.status, text: m.text, lock: m.lock && { by: m.lock.lockedBy, via: m.lock.via, participants: m.lock.participants } })));
p("actions", (await c.actions.find({ callId }).toArray()).map((a) => ({ type: a.type, status: a.status, by: a.requestedBy, key: a.idempotencyKey })));
p("audit", (await c.auditEvents.find({ callId }).sort({ at: 1 }).toArray()).map((a) => ({ type: a.type, actor: a.actor, reason: a.reason })));
const t = await c.timings.aggregate([{ $match: { callId } }, { $group: { _id: "$stage", n: { $sum: 1 }, avg: { $avg: "$ms" }, max: { $max: "$ms" } } }]).toArray();
p("timings ms", t.map((x) => ({ stage: x._id, n: x.n, avg: Math.round(x.avg), max: x.max })));
p("errors", (await c.utterances.find({ callId, error: { $exists: true } }).toArray()).map((u) => u.error));
await close();
