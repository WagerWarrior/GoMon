/**
 * After-call recap for a session page: `calls.recap` (written by apps/connectors when a call ends) plus the two outbox
 * actions it queues, found by their fixed idempotency keys: the GitHub record (`doc:<callId>`, op write_doc on the
 * gomon-records branch) and the Slack thread post (`recap:<callId>`).
 */
import { db } from "@/lib/db";

export type Counts = { decisions: number; tasks: number; changes: number; actions: number; questions: number; conflicts: number; filed: number };
export type Recap = { at: Date; text: string; counts: Counts; requestedBy?: string; note?: string };
export type Out = { status: string; url?: string; path?: string; error?: string };
export type RecapView = { recap: Recap | null; record: Out | null; slack: Out | null };

export async function recapOf(callId: string, call: { recap?: Recap } | null): Promise<RecapView> {
  const d = await db();
  const acts = await d.collection("actions").find({ idempotencyKey: { $in: [`doc:${callId}`, `recap:${callId}`] } }, { projection: { idempotencyKey: 1, status: 1, externalUrl: 1, lastError: 1, "payload.path": 1 } }).toArray();
  const pick = (k: string): Out | null => { const a: any = acts.find((x: any) => x.idempotencyKey === k); return a ? { status: a.status, url: a.externalUrl, path: a.payload?.path, error: a.lastError } : null; };
  return { recap: call?.recap ?? null, record: pick(`doc:${callId}`), slack: pick(`recap:${callId}`) };
}

/** Non-zero counts in reading order, as short labels. */
export const COUNT_LABELS: [keyof Counts, string, string][] = [
  ["decisions", "decision", "decisions"], ["tasks", "task", "tasks"], ["changes", "memory change", "memory changes"],
  ["actions", "action item", "action items"], ["questions", "open question", "open questions"], ["conflicts", "pushback", "pushbacks"], ["filed", "filed", "filed"],
];
export const countChips = (c: Counts) => COUNT_LABELS.filter(([k]) => c[k] > 0).map(([k, one, many]) => `${c[k]} ${c[k] === 1 ? one : many}`);
