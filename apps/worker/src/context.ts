/**
 * What Gomon knows beyond retrieved memories when someone talks to it: how long it has been in this call, the team's previous
 * calls and what they locked, the project's GitHub issues, and what Atlas holds. Every entry carries a source id the model must
 * cite; the agent verifies cited sources against this set before speaking.
 */
import type { Ctx } from "./governance.ts";
import { readableProjects } from "./scope.ts";
import { loadPlatform, platformFacts, platformSources } from "./platform.ts";

export type WorkspaceSource = { id: string; line: string };
export type Workspace = { header: string; sources: WorkspaceSource[] };

const env = {
  githubToken: () => process.env.GITHUB_TOKEN ?? "",
  githubRepo: () => process.env.GITHUB_REPO || "WagerWarrior/MongoDB",
};

type GhIssue = { number: number; title: string; state: string; pull_request?: unknown; created_at: string; labels?: { name?: string }[]; assignees?: { login?: string }[] };
let issueCache: { at: number; items: WorkspaceSource[] } = { at: 0, items: [] };
// With a token GitHub allows 5,000 requests an hour. Without one (the repo is public) it allows 60 per address, and one
// refresh is two requests, so the list is kept five minutes.
const issueCacheMs = () => (env.githubToken() ? 60_000 : 300_000);

/** One GitHub issue as a record line: open or closed, labels, who has it. Pure. */
export function issueLine(i: GhIssue): WorkspaceSource {
  const labels = (i.labels ?? []).map((l) => l.name).filter(Boolean).join(", ");
  const who = (i.assignees ?? []).map((a) => a.login).filter(Boolean).join(", ");
  return {
    id: `#${i.number}`,
    line: `${i.pull_request ? "PR" : "issue"} #${i.number} [${i.state}]${i.state === "open" && (i.labels ?? []).some((l) => l.name === "gomon") ? " filed by you from memory" : ""} ${i.title} (opened ${i.created_at.slice(0, 10)}${labels ? `; labels ${labels}` : ""}; ${who ? `assigned to ${who}` : "unassigned"})`,
  };
}

/** The repo's issues, open ones first (up to 30 open, then the 5 most recently closed). "Outstanding tickets" reads the open ones. */
async function githubIssues(): Promise<WorkspaceSource[]> {
  if (Date.now() - issueCache.at < issueCacheMs()) return issueCache.items;
  const get = async (q: string): Promise<GhIssue[] | null> => {
    const res = await fetch(`https://api.github.com/repos/${env.githubRepo()}/issues?${q}`, {
      headers: { ...(env.githubToken() ? { authorization: `Bearer ${env.githubToken()}` } : {}), accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? ((await res.json()) as GhIssue[]) : null;
  };
  try {
    const [open, closed] = await Promise.all([get("state=open&per_page=30&sort=created&direction=desc"), get("state=closed&per_page=5&sort=updated&direction=desc")]);
    // A failed read (rate limit, GitHub down) keeps the last list and is not retried for 30 s, so no answer waits on it twice.
    issueCache = open ? { at: Date.now(), items: [...open, ...(closed ?? [])].map(issueLine) } : { at: Date.now() - issueCacheMs() + 30_000, items: issueCache.items };
  } catch { issueCache = { at: Date.now() - issueCacheMs() + 30_000, items: issueCache.items }; /* answer from Atlas alone */ }
  return issueCache.items;
}

/**
 * The workspace section does not depend on the question, and it is the slowest and most variable read on the answer path
 * (200-1100 ms: five queries, then a sixth). It is kept per call for 10 s; a copy older than 3 s is handed out at once and
 * refreshed in the background, so an answer never waits for it after the first one.
 */
const workspaces = new Map<string, { at: number; p: Promise<Workspace>; refreshing?: boolean }>();
export function workspaceFor(ctx: Ctx, callId: string): Promise<Workspace> {
  const key = `${ctx.teamId}|${ctx.projectId}|${callId}`;
  const load = () => {
    const e = { at: Date.now(), p: loadWorkspace(ctx, callId) };
    e.p.then(() => workspaces.set(key, e), () => { if (workspaces.get(key) === e) workspaces.delete(key); });
    return e;
  };
  const hit = workspaces.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (!hit || age > 10_000) {
    const e = load();
    workspaces.set(key, e);
    return e.p;
  }
  if (age > 3000 && !hit.refreshing) {
    hit.refreshing = true;
    load();
  }
  return hit.p;
}

async function loadWorkspace(ctx: Ctx, callId: string): Promise<Workspace> {
  // Previous calls and locks come from this project and company context (contract 1); counts likewise.
  const scope = { teamId: ctx.teamId, projectId: { $in: readableProjects(ctx.projectId) } };
  const [platform, call, previous, recentLocks, kinds, issues] = await Promise.all([
    loadPlatform(ctx.c, ctx.teamId, callId),
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
    header: `${platformFacts(platform)}\nCALL SO FAR, OPEN CALL ITEMS and RECENT TURNS hold what was said since you joined. GitHub repo: ${env.githubRepo()}.`,
    // Fixed facts first; then filed tickets, GitHub issues, the full memory index, past calls and recent locks.
    // Closed issues go last: they are history (some carry keys from before a reset), and the budget cuts from the end.
    sources: [...platformSources(platform), ...issues.filter((i) => !i.line.includes("[closed]")), ...calls, ...locks, stats, ...issues.filter((i) => i.line.includes("[closed]"))],
  };
}
