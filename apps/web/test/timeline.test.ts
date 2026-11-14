import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline } from "../lib/timeline";

const at = (s: number) => new Date(Date.UTC(2026, 10, 14, 12, 0, s)).toISOString();
const base = { utterances: [], says: [], runs: [], items: [], audit: [], conflicts: [], actions: [] };

test("people go left, Gomon and the operator go right, Gomon's own transcript is skipped", () => {
  const t = buildTimeline({ ...base,
    utterances: [{ _id: 1, startedAt: at(0), speaker: { displayName: "Robert" }, text: "hi" }, { _id: 2, startedAt: at(1), speaker: { displayName: "Gomon" }, text: "echo" }, { _id: 3, startedAt: at(2), speaker: { displayName: "Mission control" }, text: "Gomon, status" }],
    says: [{ _id: 9, createdAt: at(3), text: "On it", status: "spoken" }] });
  assert.deepEqual(t.map((e: any) => [e.kind, e.who, e.side]), [["msg", "Robert", "left"], ["msg", "Mission control", "right"], ["msg", "Gomon", "right"]]);
});

test("back-to-back agent runs fold into one thinking line; a message in between splits them", () => {
  const t = buildTimeline({ ...base,
    runs: [{ _id: 1, at: at(0), retrievedMemoryIds: [1, 2] }, { _id: 2, at: at(1), retrievedMemoryIds: [3], wake: true }, { _id: 3, at: at(5), retrievedMemoryIds: [] }],
    utterances: [{ _id: 7, startedAt: at(3), speaker: { displayName: "Ana" }, text: "x" }] });
  assert.deepEqual(t.map((e: any) => (e.kind === "think" ? `think${e.n}:${e.hits}:${e.wake}` : e.kind)), ["think2:3:true", "msg", "think1:0:false"]);
});

test("decisions, locks, vetoes, conflicts and sends become inline events in time order", () => {
  const t = buildTimeline({ ...base,
    items: [{ _id: 1, createdAt: at(0), kind: "decision", text: "Use Redis", status: "promoted" }],
    audit: [{ _id: 2, at: at(1), type: "memory_locked", actor: "Max" }, { _id: 3, at: at(2), type: "item_rejected", actor: "Ana" }, { _id: 4, at: at(2), type: "ask_memory_on" }],
    conflicts: [{ _id: 5, createdAt: at(3), memoryKey: "D-1", note: "already decided" }],
    actions: [{ _id: 6, createdAt: at(4), type: "post_slack", status: "confirmed", payload: { title: "D-2" } }] });
  assert.deepEqual(t.map((e: any) => e.kind), ["save", "lock", "lock", "flag", "send"]);
  assert.equal((t[0] as any).status, "locked"); assert.equal((t[2] as any).veto, true); assert.equal((t[4] as any).tool, "Slack");
});
