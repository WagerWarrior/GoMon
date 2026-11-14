/**
 * One session as a chat: people on the left, Gomon and the operator on the right, and Gomon's work inline
 * (thinking, saving a decision, locking, flagging a conflict, sending to a tool). Built from the session's own Atlas rows.
 * buildTimeline is pure (tested in test/timeline.test.ts); timeline() loads and caches it.
 */
import { session } from "./platform";
import { toolName } from "./workflows";

export type Entry =
  | { kind: "msg"; id: string; at: string; who: string; side: "left" | "right"; text: string; via?: string; status?: string }
  | { kind: "think"; id: string; at: string; n: number; hits: number; wake: boolean }
  | { kind: "save"; id: string; at: string; item: string; text: string; status: string }
  | { kind: "lock"; id: string; at: string; who: string; text: string; veto: boolean }
  | { kind: "flag"; id: string; at: string; text: string }
  | { kind: "send"; id: string; at: string; tool: string; status: string; text: string; url?: string | null };

const iso = (t: unknown) => { const d = t ? new Date(t as string) : null; return d && !isNaN(+d) ? d.toISOString() : null; };

export function buildTimeline(s: { utterances: any[]; says: any[]; runs: any[]; items: any[]; audit: any[]; conflicts: any[]; actions: any[] }): Entry[] {
  const out: Entry[] = [];
  type Draft = Entry extends infer E ? (E extends Entry ? Omit<E, "at"> & { at: string | null } : never) : never;
  const add = (e: Draft) => { if (e.at) out.push(e as Entry); };
  for (const u of s.utterances) {
    const who = u.speaker?.displayName ?? "Someone";
    if (who === "Gomon") continue; // Gomon's voice is shown from `says`, not from the bot hearing itself
    add({ kind: "msg", id: `u${u._id}`, at: iso(u.startedAt ?? u.receivedAt), who, side: who === "Mission control" ? "right" : "left", text: u.text ?? "", via: u.source });
  }
  for (const x of s.says) add({ kind: "msg", id: `s${x._id}`, at: iso(x.createdAt), who: "Gomon", side: "right", text: x.text ?? "", via: x.reason === "operator" ? "operator" : "voice", status: x.status });
  for (const r of s.runs) add({ kind: "think", id: `r${r._id}`, at: iso(r.at), n: 1, hits: (r.retrievedMemoryIds ?? []).length, wake: !!r.wake });
  for (const i of s.items) add({ kind: "save", id: `i${i._id}`, at: iso(i.createdAt), item: String(i.kind ?? "note").replace(/_/g, " "), text: i.text ?? "", status: i.status === "promoted" ? "locked" : i.status === "rejected" ? "vetoed" : i.status ?? "" });
  for (const a of s.audit) {
    const t = String(a.type ?? "");
    if (/lock|promot/.test(t)) add({ kind: "lock", id: `a${a._id}`, at: iso(a.at), who: a.actor ?? "team", text: a.reason ?? t.replace(/_/g, " "), veto: false });
    else if (/reject|veto/.test(t)) add({ kind: "lock", id: `a${a._id}`, at: iso(a.at), who: a.actor ?? "team", text: a.reason ?? t.replace(/_/g, " "), veto: true });
  }
  for (const c of s.conflicts) add({ kind: "flag", id: `c${c._id}`, at: iso(c.createdAt), text: `${c.memoryKey ? c.memoryKey + ": " : ""}${c.note ?? ""}` });
  for (const a of s.actions) add({ kind: "send", id: `x${a._id}`, at: iso(a.sentAt ?? a.createdAt), tool: toolName(String(a.type)), status: a.status, text: a.payload?.title ?? a.payload?.text ?? "", url: a.externalUrl ?? null });
  out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  // Fold back-to-back thinking into one line: "thought 6x, 18 memories".
  const folded: Entry[] = [];
  for (const e of out) {
    const prev = folded[folded.length - 1];
    if (e.kind === "think" && prev?.kind === "think") { prev.n += 1; prev.hits += e.hits; prev.wake ||= e.wake; prev.at = e.at; }
    else folded.push(e.kind === "think" ? { ...e } : e);
  }
  return folded;
}

export async function timeline(callId: string, limit = 400) {
  const s = await session(callId);
  return buildTimeline(s).slice(-limit);
}
