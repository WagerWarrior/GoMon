/**
 * Max (connectors): after-call recap. Claude Meetings emails a summary after a call; Gomon's recap is built from the
 * governed record instead of a free-form summary, so every line points at something stored in Atlas:
 * decisions locked in THIS call (with keys), corrections and forgets, open action items, open questions, the times team
 * memory pushed back (conflict -> memory key), and what was filed (GitHub / Slack links). The rolling `calls.summary`
 * (apps/worker) is the prose lead. Deterministic: no model call, nothing invented.
 *
 * Stored on `calls.recap` { at, text, counts, requestedBy?, note? } for the workspace, and posted once into the call's Slack
 * thread through the outbox (idempotencyKey `recap:<callId>`, policy-checked as the first participant allowed to post).
 */
import type { Db } from "mongodb";
import { checkPolicy } from "./policy";

const WINDOW_MS = 6 * 3600_000; // only calls that ended recently; seeded history never back-fires
const MAX_LINES = 8;

export type Recap = { text: string; counts: { decisions: number; changes: number; actions: number; questions: number; conflicts: number; filed: number } };

const bullet = (xs: string[], more: number) => xs.map((x) => `• ${x}`).join("\n") + (more > 0 ? `\n• …and ${more} more` : "");
const cut = (s: unknown, n = 160) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
function minutes(a?: Date, b?: Date) { return a && b ? Math.max(1, Math.round((+b - +a) / 60_000)) : null; }

export async function buildRecap(d: Db, call: any): Promise<Recap> {
  const callId = call._id; const scope = { teamId: call.teamId, projectId: call.projectId };
  const [decided, changes, items, conflicts, filed] = await Promise.all([
    d.collection("memories").find({ ...scope, status: "active", "sourceRefs.callId": callId, "lock.lockedAt": { $exists: true } }).sort({ "lock.lockedAt": 1 }).toArray(),
    d.collection("audit_events").find({ ...scope, callId, type: { $in: ["memory_corrected", "memory_forgotten"] } }).sort({ at: 1 }).toArray(),
    d.collection("call_items").find({ callId, kind: { $in: ["action", "open_question"] }, status: { $in: ["proposed", "locking"] } }).sort({ createdAt: 1 }).toArray(),
    d.collection("conflicts").find({ callId, severity: { $in: ["high", "medium"] } }).sort({ createdAt: 1 }).toArray(),
    d.collection("actions").find({ callId, status: { $in: ["sent", "confirmed"] }, externalUrl: { $exists: true } }).sort({ _id: 1 }).toArray(),
  ]);
  const actions = items.filter((i) => i.kind === "action"); const questions = items.filter((i) => i.kind === "open_question");
  const seen = new Set<string>(); const pushback = conflicts.filter((c) => { const k = `${c.memoryKey}:${c.note}`; if (seen.has(k)) return false; seen.add(k); return true; });

  const mins = minutes(call.startedAt, call.endedAt); const people = (call.participants ?? []) as string[];
  const lines: string[] = [`*Recap: ${call.title ?? callId}*${mins ? ` · ${mins} min` : ""}${people.length ? ` · ${people.join(", ")}` : ""}`];
  if (typeof call.summary === "string" && call.summary.trim()) lines.push(cut(call.summary, 600));
  const section = (title: string, xs: string[]) => { if (xs.length) lines.push("", `*${title}*`, bullet(xs.slice(0, MAX_LINES), xs.length - MAX_LINES)); };
  section("Decided", decided.map((m) => `${m.key ?? m.kind}: ${cut(m.text)}${m.lock?.participants?.length ? ` (${m.lock.participants.join(", ")})` : ""}`));
  if (!decided.length) lines.push("", "No decisions were locked in this call.");
  section("Changed in memory", changes.map((e) => `${e.type === "memory_forgotten" ? "Forgot" : "Corrected"} ${e.ref?.key ?? "a memory"}${e.reason ? `: ${cut(e.reason, 120)}` : ""} (${e.actor})`));
  section("Action items", actions.map((i) => cut(i.text)));
  section("Open questions", questions.map((i) => cut(i.text)));
  section("Team memory pushed back", pushback.map((c) => `${c.memoryKey ?? "memory"}: ${cut(c.note, 140)}${c.spoken ? "" : " (flagged silently)"}`));
  section("Filed", filed.map((a) => `${cut(a.payload?.title ?? a.type, 80)}: ${a.externalUrl}`));
  if (process.env.WEB_BASE_URL) lines.push("", `Full session: ${process.env.WEB_BASE_URL.replace(/\/$/, "")}/sessions/${encodeURIComponent(callId)}`);

  return { text: lines.join("\n"), counts: { decisions: decided.length, changes: changes.length, actions: actions.length, questions: questions.length, conflicts: pushback.length, filed: filed.length } };
}

/** Recap every recently ended call once. Returns how many recaps were written. */
export async function sweepRecaps(d: Db, now = new Date()): Promise<number> {
  const calls = await d.collection("calls").find({ status: "ended", endedAt: { $gte: new Date(+now - WINDOW_MS) }, utteranceSeq: { $gt: 0 }, recap: { $exists: false } }).limit(20).toArray();
  let n = 0;
  for (const call of calls) {
    const r = await buildRecap(d, call);
    let requestedBy: string | undefined;
    for (const p of (call.participants ?? []) as string[]) {
      if ((await checkPolicy(d, call.teamId, call.projectId, p, "post_slack")).allowed) { requestedBy = p; break; }
    }
    const recap = { at: new Date(), ...r, ...(requestedBy ? { requestedBy } : { note: "no participant may post_slack; recap stored only" }) };
    // Claim by writing the recap only where none exists: two connector workers never post twice.
    const won = await d.collection("calls").updateOne({ _id: call._id, recap: { $exists: false } }, { $set: { recap } });
    if (!won.modifiedCount) continue;
    n++;
    if (!requestedBy) continue;
    const idempotencyKey = `recap:${call._id}`;
    await d.collection("actions").updateOne({ idempotencyKey }, { $setOnInsert: { idempotencyKey, type: "post_slack", callId: call._id, teamId: call.teamId, projectId: call.projectId,
      payload: { text: r.text, callId: call._id, kind: "recap" }, requestedBy, status: "queued", attempts: 0, createdAt: new Date(), via: "recap" } }, { upsert: true });
    await d.collection("audit_events").insertOne({ teamId: call.teamId, projectId: call.projectId, callId: call._id, at: new Date(), type: "recap_queued", actor: requestedBy, reason: "call ended", ref: { counts: r.counts, idempotencyKey } });
  }
  return n;
}
