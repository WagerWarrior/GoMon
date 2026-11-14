import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveGomonState, GOMON_STATES } from "../lib/gomon/states";

const NOW = Date.parse("2026-11-14T18:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const base = { call_items: [], audit_events: [], utterances: [] } as any;

test("every state the avatar can show has a face and a label", () => {
  for (const [k, s] of Object.entries(GOMON_STATES)) { assert.ok(s.label, k); assert.ok(["idle", "thinking", "happy"].includes(s.mood), k); }
});
test("quiet call: listening", () => {
  assert.equal(deriveGomonState(base, NOW).key, "listening");
});
test("an item inside its veto window: locking, with the seconds left", () => {
  const s = deriveGomonState({ ...base, call_items: [{ status: "locking", lockAnnouncedAt: ago(3), vetoMs: 10000 }] }, NOW);
  assert.equal(s.key, "locking"); assert.equal(s.secondsLeft, 7);
});
test("recent audit events map to faces, and only while fresh", () => {
  const ev = (type: string, s: number) => ({ ...base, audit_events: [{ type, at: ago(s), actor: "Priya" }] });
  assert.equal(deriveGomonState(ev("memory_promoted", 2), NOW).key, "locked");
  assert.equal(deriveGomonState(ev("item_rejected", 2), NOW).key, "vetoed");
  assert.equal(deriveGomonState(ev("action_sent", 2), NOW).key, "acting");
  assert.equal(deriveGomonState(ev("memory_corrected", 2), NOW).key, "recalling");
  assert.equal(deriveGomonState(ev("memory_promoted", 30), NOW).key, "listening", "stale events fade back to listening");
});
test("Gomon's own fresh utterance: speaking; locking still wins", () => {
  const sp = { ...base, utterances: [{ speaker: { displayName: "Gomon" }, startedAt: ago(1) }] };
  assert.equal(deriveGomonState(sp, NOW).key, "speaking");
  assert.equal(deriveGomonState({ ...sp, call_items: [{ status: "locking", lockAnnouncedAt: ago(1) }] }, NOW).key, "locking");
});
test("an ask in flight: recalling", () => {
  assert.equal(deriveGomonState(base, NOW, { asking: true }).key, "recalling");
});
