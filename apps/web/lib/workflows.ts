/**
 * Workflow runs, rebuilt from Atlas: one run per locked decision, with each step the system took
 * (meeting -> lock -> policy -> Slack -> GitHub -> read-back). No stored workflow definitions yet; the steps mirror apps/connectors.
 */
import { ObjectId } from "mongodb";
import { cached, db, scope } from "./db";

export type StepState = "done" | "failed" | "waiting" | "skipped";
export interface Step { key: string; label: string; state: StepState; detail?: string; url?: string | null; at?: string | null }
export interface Run { id: string; title: string; key?: string; callId?: string; at: string; steps: Step[] }

/** Action types the connectors know, and a readable name for each. Unknown types still show, title-cased. */
export const TOOL_NAMES: Record<string, string> = { post_slack: "Slack", create_issue: "GitHub", create_ticket: "Linear", send_email: "Email", post_notion: "Notion" };
export const toolName = (t: string) => TOOL_NAMES[t] ?? t.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const slackUrl = (id?: string) => { const [ch, ts] = String(id ?? "").split(":"); return ch && ts ? `https://slack.com/archives/${ch}/p${ts.replace(".", "")}` : null; };
const st = (s?: string): StepState => (s === "confirmed" || s === "sent" ? "done" : s === "failed" || s === "denied" ? "failed" : s ? "waiting" : "skipped");

export function workflowRuns() {
  return cached("workflows", 2000, async () => {
    const d = await db(); const { teamId, projectId } = scope(); const tp = { teamId, projectId };
    const [locks, acts, wfs] = await Promise.all([
      d.collection("audit_events").find({ ...tp, type: { $in: ["memory_locked", "memory_promoted"] } }).sort({ at: -1 }).limit(60).toArray(),
      d.collection("actions").find(tp).sort({ createdAt: -1 }).limit(300).toArray(),
      d.collection("workflows").find(tp, { projection: { steps: 1, enabled: 1 } }).toArray(),
    ]);
    // The tools in play: what enabled workflows send to, plus anything the outbox has actually used. Nothing hard-coded.
    const tools = [...new Set([...wfs.filter((w) => w.enabled).flatMap((w) => (w.steps ?? []).map((x: any) => String(x.type))), ...acts.map((a) => String(a.type))])].filter(Boolean);
    const memIds = [...new Set([...locks.map((l) => l.ref?.memoryId ?? l.memoryId), ...acts.map((a) => a.memoryId)].filter(Boolean).map(String))];
    const mems = await d.collection("memories").find({ _id: { $in: memIds.flatMap((x) => { try { return [new ObjectId(x)]; } catch { return []; } }) } }, { projection: { text: 1, key: 1, kind: 1 } }).toArray();
    const mem = new Map(mems.map((m) => [String(m._id), m]));
    const byMem = new Map<string, any[]>();
    for (const a of acts) if (a.memoryId) (byMem.get(String(a.memoryId)) ?? byMem.set(String(a.memoryId), []).get(String(a.memoryId))!).push(a);
    const seen = new Set<string>();
    const runs: Run[] = [];
    const build = (memoryId: string, lock: any | null) => {
      if (seen.has(memoryId)) return; seen.add(memoryId);
      const m = mem.get(memoryId); const a = byMem.get(memoryId) ?? [];
      const first = a[a.length - 1]; const callId = lock?.callId ?? first?.callId;
      const at = new Date(lock?.at ?? first?.createdAt ?? Date.now()).toISOString();
      runs.push({
        id: memoryId, title: m?.text ?? first?.payload?.title ?? "Locked decision", key: m?.key, callId, at,
        steps: [
          { key: "meeting", label: "Meeting", state: callId ? "done" : "skipped", detail: callId },
          { key: "lock", label: "Locked", state: lock || m ? "done" : "skipped", detail: lock ? `${lock.actor ?? "team"}${lock.reason ? " · " + lock.reason : ""}` : m?.key, at: lock ? new Date(lock.at).toISOString() : null },
          { key: "policy", label: "Policy", state: first?.policyCheck ? (first.policyCheck.allowed ? "done" : "failed") : first ? "waiting" : "skipped", detail: first?.policyCheck?.reason },
          ...tools.map((t): Step => { const x = a.find((y) => y.type === t); return { key: t, label: toolName(t), state: st(x?.status), detail: x ? `${x.status}${x.externalId && t !== "post_slack" ? " · " + x.externalId : ""}` : undefined, url: x?.externalUrl ?? (t === "post_slack" ? slackUrl(x?.externalId) : null) }; }),
          { key: "confirm", label: "Read-back", state: a.some((x) => x.status === "confirmed") ? "done" : a.length ? "waiting" : "skipped" },
        ],
      });
    };
    for (const l of locks) { const id = l.ref?.memoryId ?? l.memoryId; if (id) build(String(id), l); }
    for (const a of acts) if (a.memoryId) build(String(a.memoryId), null);
    runs.sort((x, y) => y.at.localeCompare(x.at));
    const count = (k: string) => runs.filter((r) => r.steps.find((s) => s.key === k)?.state === "done").length;
    return JSON.parse(JSON.stringify({ runs, tools: tools.map((t) => ({ type: t, name: toolName(t), done: count(t) })), totals: { runs: runs.length, slack: count("post_slack"), github: count("create_issue"), confirmed: count("confirm") } }));
  });
}

/** Stored workflows (apps/connectors/src/workflows.ts) with fire counts. */
export function storedWorkflows() {
  return cached("stored-workflows", 2000, async () => {
    const d = await db(); const { teamId, projectId } = scope();
    const [wfs, runs] = await Promise.all([
      d.collection("workflows").find({ teamId, projectId }).sort({ createdAt: 1 }).toArray(),
      d.collection("workflow_runs").aggregate([{ $match: { teamId, projectId } }, { $group: { _id: "$workflowId", fired: { $sum: { $cond: [{ $eq: ["$status", "fired"] }, 1, 0] } }, last: { $max: "$firedAt" } } }]).toArray(),
    ]);
    const by = new Map(runs.map((r) => [String(r._id), r]));
    return JSON.parse(JSON.stringify(wfs.map((w) => ({ ...w, fired: by.get(String(w._id))?.fired ?? 0, lastFired: by.get(String(w._id))?.last ?? null }))));
  });
}

export async function setWorkflowEnabled(id: string, enabled: boolean, actor: string) {
  const d = await db(); const { teamId, projectId } = scope();
  if (!ObjectId.isValid(id)) return false;
  const now = new Date();
  const r = await d.collection("workflows").updateOne({ _id: new ObjectId(id), teamId, projectId }, { $set: { enabled, updatedAt: now, ...(enabled ? { enabledAt: now } : {}) } });
  if (r.matchedCount) await d.collection("audit_events").insertOne({ teamId, projectId, at: now, type: enabled ? "workflow_enabled" : "workflow_disabled", actor, reason: id });
  return r.matchedCount === 1;
}
