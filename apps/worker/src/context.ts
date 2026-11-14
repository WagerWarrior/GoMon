/**
 * What Gomon knows beyond retrieved memories when someone talks to it: how long it has been in this call, the team's previous
 * calls and what they locked, the project's GitHub issues, and what Atlas holds. Every entry carries a source id the model must
 * cite; the agent verifies cited sources against this set before speaking.
 */
import type { Ctx } from "./governance.ts";
import { readableProjects } from "./scope.ts";

export type WorkspaceSource = { id: string; line: string };
export type Workspace = { header: string; sources: WorkspaceSource[] };

const env = {
  githubToken: () => process.env.GITHUB_TOKEN ?? "",
  githubRepo: () => process.env.GITHUB_REPO || "WagerWarrior/MongoDB",
};

type GhIssue = { number: number; title: string; state: string; pull_request?: unknown; created_at: string };
let issueCache: { at: number; items: WorkspaceSource[] } = { at: 0, items: [] };
const ISSUE_CACHE_MS = 60_000;

async function githubIssues(): Promise<WorkspaceSource[]> {
  if (!env.githubToken() || Date.now() - issueCache.at < ISSUE_CACHE_MS) return issueCache.items;
  try {
    const res = await fetch(`https://api.github.com/repos/${env.githubRepo()}/issues?state=all&per_page=10&sort=created&direction=desc`, {
      headers: { authorization: `Bearer ${env.githubToken()}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const items = ((await res.json()) as GhIssue[]).map((i) => ({
        id: `#${i.number}`,
        line: `${i.pull_request ? "PR" : "issue"} #${i.number} [${i.state}] ${i.title} (${i.created_at.slice(0, 10)})`,
      }));
      issueCache = { at: Date.now(), items };
    }
  } catch { /* GitHub slow or down: answer from Atlas alone */ }
  return issueCache.items;
}

export async function workspaceFor(ctx: Ctx, callId: string): Promise<Workspace> {
  // Previous calls and locks come from this project and company context (contract 1); counts likewise.
  const scope = { teamId: ctx.teamId, projectId: { $in: readableProjects(ctx.projectId) } };
  const [call, previous, recentLocks, kinds, issues] = await Promise.all([
    ctx.c.calls.findOne({ _id: callId as never }, { projection: { title: 1, startedAt: 1 } }),
    // Real conversations only (skip near-empty test calls); seeded past meetings carry a summary instead.
    ctx.c.calls.find({ ...scope, _id: { $ne: callId as never }, $or: [{ utteranceSeq: { $gte: 10 } }, { summary: { $type: "string" } }] }).sort({ startedAt: -1 }).limit(4).project({ title: 1, startedAt: 1, utteranceSeq: 1, summary: 1 }).toArray(),
    ctx.c.memories.find({ ...scope, status: "active", origin: "call" }).sort({ "lock.lockedAt": -1 }).limit(6).project({ key: 1, text: 1, sourceRefs: 1, lock: 1 }).toArray(),
    ctx.c.memories.aggregate<{ _id: string; n: number }>([{ $match: { ...scope, status: "active" } }, { $group: { _id: "$kind", n: { $sum: 1 } } }]).toArray(),
    githubIssues(),
  ]);
  const callOf = (m: { sourceRefs?: unknown }) => (m.sourceRefs as { callId?: string }[] | undefined)?.find((r) => r.callId)?.callId;
  const titles = new Map<string, string>();
  const lockCallIds = [...new Set(recentLocks.map(callOf).filter((x): x is string => !!x))];
  if (lockCallIds.length) {
    for (const cd of await ctx.c.calls.find({ _id: { $in: lockCallIds as never[] } }).project({ title: 1 }).toArray()) titles.set(String(cd._id), String(cd.title ?? "untitled"));
  }
  const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "?");
  const calls: WorkspaceSource[] = previous.map((p) => {
    const id = String(p._id);
    const keys = recentLocks.filter((m) => callOf(m) === id).map((m) => String(m.key));
    const summary = typeof p.summary === "string" ? ` Summary: ${p.summary.slice(0, 300)}` : "";
    return { id: `call:${id}`, line: `previous call "${p.title ?? "untitled"}" (${day(p.startedAt)}${p.utteranceSeq ? `, ${p.utteranceSeq} utterances` : ""})${keys.length ? `; locked ${keys.join(", ")}` : ""}.${summary}` };
  });
  const locks: WorkspaceSource[] = recentLocks.map((m) => {
    const cid = callOf(m);
    const lock = m.lock as { lockedAt?: Date; via?: string } | undefined;
    return { id: String(m.key), line: `locked decision ${m.key} (${day(lock?.lockedAt)}${cid ? `, in "${titles.get(cid) ?? cid}"` : ""}, via ${lock?.via ?? "?"}): ${String(m.text).slice(0, 140)}` };
  });
  const startedAt = call?.startedAt instanceof Date ? call.startedAt.getTime() : Date.now();
  const mins = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
  const stats: WorkspaceSource = {
    id: "atlas",
    line: `MongoDB Atlas database "gomon": active memories ${kinds.map((k) => `${k.n} ${k._id}`).join(", ") || "none"}.`,
  };
  return {
    header: `This call: "${call?.title ?? "untitled"}", you joined about ${mins} minute${mins === 1 ? "" : "s"} ago. What was said since then is in CALL SO FAR, OPEN CALL ITEMS and RECENT TURNS. GitHub repo: ${env.githubRepo()}.`,
    sources: [...locks, ...calls, ...issues, stats],
  };
}
