/**
 * Voice -> GitHub. The analysis returns what was asked in the words people used ("assign issue fifteen to Max", "put R-21 on the
 * Enterprise SSO board"); this resolves names to GitHub logins (team records only, never guessed), spoken issue refs to issue
 * numbers, and board names to Gomon projects, then enqueues contract-6 `github` actions. Nothing here calls GitHub: the
 * connector sends, and announce.ts speaks the result.
 */
import type { ObjectId } from "mongodb";
import { enqueueGithub, githubKey, memoryIssue, type Ctx } from "./governance.ts";
import type { GithubIntent } from "./llm.ts";
import { learnAlias, loadPeople, resolvePerson, type Person } from "./people.ts";
import { createProjectWithBoard, findProject } from "./projects.ts";
import type { Retrieved } from "./retrieve.ts";
import { memoryFilter } from "./scope.ts";
import type { GithubOp, Memory, Project } from "./shapes.ts";

const UNITS: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "15", "#15", "fifteen", "one five" (digit by digit), "twenty one", "a hundred and five" -> number; null if not a number. */
export function spokenNumber(s: string): number | null {
  const t = s.toLowerCase().replace(/\b(issue|ticket|number|no\.?)\b/g, " ").replace(/[#,-]/g, " ").trim();
  if (/^[\d\s]+$/.test(t) && t) return Number(t.replace(/\s+/g, ""));
  const words = t.split(/\s+/).filter((w) => w && w !== "and" && w !== "a");
  if (!words.length) return null;
  if (words.length > 1 && words.every((w) => w in UNITS)) return Number(words.map((w) => UNITS[w]).join(""));
  let n = 0;
  for (const w of words) {
    if (w in UNITS) n += UNITS[w];
    else if (w in TEENS) n += TEENS[w];
    else if (w in TENS) n += TENS[w];
    else if (w === "hundred") n = (n || 1) * 100;
    else return null;
  }
  return n > 0 ? n : null;
}

const KEY = /^([a-z])[\s-]?(\d{1,3})$/i;
/** Issue actions (voice/UI/workflow) whose externalId names an issue: `repo#15`, or `repo#15:update_issue:…`. */
const ISSUE_ID = /#(\d+)(?::|$)/;
const ISSUE_TYPES = { $or: [{ type: "create_issue" }, { type: "github", "payload.op": "create_issue" }] };

/** The issue filed for a memory, if any. Failed or denied filings never count; one a demo reset reverted no longer does. Pure. */
export function filedIssueQuery(teamId: string, memoryId: ObjectId): Record<string, unknown> {
  return { teamId, memoryId, ...ISSUE_TYPES, status: { $nin: ["failed", "denied"] }, reverted: { $ne: true } };
}

type IssueRef = { n: number } | { say: string };

/** Spoken ref -> issue number: digits/words, a memory key we filed an issue for, or "" = the latest issue touched on this call. */
async function resolveIssue(ctx: Ctx, callId: string, ref: string): Promise<IssueRef> {
  const r = ref.trim();
  if (!r) {
    const last = await ctx.c.actions.findOne({ teamId: ctx.teamId, callId, externalId: { $regex: ISSUE_ID.source } }, { sort: { _id: -1 }, projection: { externalId: 1 } });
    const m = last && ISSUE_ID.exec(String(last.externalId));
    return m ? { n: Number(m[1]) } : { say: "Which issue? Give me the number." };
  }
  const k = KEY.exec(r);
  if (k) {
    const key = `${k[1].toUpperCase()}-${k[2].padStart(2, "0")}`;
    const mem = await ctx.c.memories.findOne({ ...memoryFilter(ctx), key }, { projection: { _id: 1 } });
    if (!mem) return { say: `I don't see ${key} in team memory.` };
    const filed = await ctx.c.actions.find(filedIssueQuery(ctx.teamId, mem._id)).sort({ _id: -1 }).limit(1).next();
    const m = filed?.externalId && ISSUE_ID.exec(String(filed.externalId));
    if (m) return { n: Number(m[1]) };
    return { say: filed ? `${key}'s issue is still being filed, try again in a moment.` : `${key} doesn't have an issue yet. Want me to file one?` };
  }
  const n = spokenNumber(r);
  return n ? { n } : { say: `I didn't catch the issue number.` };
}

function names(list: string[]): string {
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** Spoken names -> logins; unknown or ambiguous names are reported, never guessed. */
function resolvePeople(people: Person[], spoken: string[], speaker: string): { found: Person[]; unknown: string[] } {
  const found: Person[] = [];
  const unknown: string[] = [];
  for (const s of spoken.filter((x) => x.trim())) {
    const p = resolvePerson(people, s, speaker);
    if (p) { if (!found.some((f) => f.login === p.login)) found.push(p); } else unknown.push(s.trim());
  }
  return { found, unknown };
}

const dontKnow = (unknown: string[]) => (unknown.length ? ` I don't know ${names(unknown.map((u) => `${u}'s`))} GitHub, so I left that out.` : "");
const first = (p: Person) => p.display.split(" ")[0];

/** Board for a spoken project name ("this project" = the call's). `say` explains why there is none. */
async function resolveBoard(ctx: Ctx, spoken: string): Promise<{ project: Project | null; say: string }> {
  const s = spoken.trim();
  if (!s) return { project: null, say: "" };
  const here = /^(this|our|the)( current)? (project|board)$/i.test(s);
  const project = here
    ? await ctx.c.projects.findOne({ _id: ctx.projectId as never, teamId: ctx.teamId }) as Project | null
    : await findProject(ctx, s.replace(/\s+(board|project)$/i, ""));
  if (!project) return { project: null, say: ` There's no ${s} project yet, so it's not on a board.` };
  if (project.github?.projectId) return { project, say: "" };
  const pending = await ctx.c.actions.findOne({ teamId: ctx.teamId, type: "github", "payload.op": "create_project", "payload.project": project._id, status: { $in: ["queued", "sending"] } }, { projection: { _id: 1 } });
  return pending ? { project, say: "" } : { project: null, say: ` ${project.name} doesn't have a GitHub board yet.` };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const spokenDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/**
 * Enqueue the GitHub intent and return the spoken acknowledgment ("On it, filing that for Max."). Throws PolicyDenied when the
 * speaker may not write to GitHub (the caller speaks it). `resolveMemory` is the agent's key/id resolver (retrieved set first).
 */
export async function handleGithubIntent(
  ctx: Ctx, callId: string, utteranceId: ObjectId, speaker: string, g: GithubIntent,
  resolveMemory: (ref: string) => Promise<Retrieved | null>,
): Promise<string> {
  const key = (op: GithubOp, n = 0) => githubKey(callId, utteranceId, op, n);
  const people = g.assignees.length || g.unassign.length ? await loadPeople(ctx) : [];
  const add = resolvePeople(people, g.assignees, speaker);
  const remove = resolvePeople(people, g.unassign, speaker);
  // A misspelled name that resolved by sound is remembered on that person (people.ts).
  for (const s of [...g.assignees, ...g.unassign]) {
    const p = resolvePerson(people, s, speaker);
    if (p && !["me", "myself", "i"].includes(s.trim().toLowerCase())) void learnAlias(ctx, p, s, callId).catch((e) => console.error("[alias]", e instanceof Error ? e.message : e));
  }
  const labels = [...new Set(g.labels.map((l) => l.trim().toLowerCase()).filter(Boolean))];
  const forWho = add.found.length ? ` for ${names(add.found.map(first))}` : "";

  if (g.op === "create_project") {
    if (!g.project.trim()) return "What should I call the project?";
    const p = await createProjectWithBoard(ctx, { name: g.project, description: g.body || undefined, actor: speaker, callId });
    if (p.created) return `On it, starting ${p.name}${p.boardQueued ? " and its GitHub board" : ""}.`;
    return `${p.name} already exists${p.boardQueued ? ", I'll set up its GitHub board" : ", so I'll use that one"}.`;
  }

  if (g.op === "create_milestone") {
    const title = (g.milestone || g.title).trim();
    if (!title) return "What should I call the milestone?";
    const due = DATE.test(g.dueOn) ? g.dueOn : "";
    await enqueueGithub(ctx, callId, speaker, "create_milestone", { title, ...(g.body ? { description: g.body } : {}), ...(due ? { dueOn: `${due}T12:00:00Z` } : {}) }, key("create_milestone"));
    return `On it, setting up the ${title} milestone${due ? ` for ${spokenDate(due)}` : ""}.`;
  }

  if (g.op === "create_issue") {
    const board = await resolveBoard(ctx, g.project);
    const ref = g.memoryId ? await resolveMemory(g.memoryId) : null;
    const mem = ref ? await ctx.c.memories.findOne({ _id: ref._id }) as (Memory & { _id: ObjectId }) | null : null;
    if (mem) {
      // Already filed (by voice, a click or a workflow): apply the asked-for changes to that issue instead of a duplicate.
      const filed = await ctx.c.actions.find(filedIssueQuery(ctx.teamId, mem._id)).sort({ _id: -1 }).limit(1).next();
      if (filed) {
        const m = filed.externalId && ISSUE_ID.exec(String(filed.externalId));
        if (!m) return `${mem.key ?? "That"} is already being filed.${dontKnow(add.unknown)}`;
        const n = Number(m[1]);
        let i = 0;
        if (add.found.length || labels.length) await enqueueGithub(ctx, callId, speaker, "update_issue", { issue: n, ...(add.found.length ? { addAssignees: add.found.map((p) => p.login) } : {}), ...(labels.length ? { addLabels: labels } : {}) }, key("update_issue", i++));
        if (board.project) await enqueueGithub(ctx, callId, speaker, "add_to_project", { issue: n, project: board.project._id }, key("add_to_project", i++));
        return `${mem.key} already has issue ${n}${i ? ", I'll update it" : ""}.${dontKnow(add.unknown)}${board.say}`;
      }
    }
    const base = mem
      ? memoryIssue(mem, callId)
      : { title: (g.title || g.body || "Follow-up from the design call").slice(0, 70), body: `${g.body || g.title}\n\nRequested by ${speaker} on call \`${callId}\`.`, labels: ["gomon"] };
    const payload = {
      ...base, labels: [...new Set([...base.labels, ...labels])], assignees: add.found.map((p) => p.login),
      ...(g.milestone.trim() ? { milestone: g.milestone.trim() } : {}), ...(board.project ? { project: board.project._id } : {}), ...(mem ? { memoryId: String(mem._id) } : {}),
    };
    await enqueueGithub(ctx, callId, speaker, "create_issue", payload, key("create_issue"), mem ? { memoryId: mem._id } : {});
    return `On it, filing ${mem?.key ?? "that"}${forWho}.${dontKnow(add.unknown)}${board.say}`;
  }

  if (g.op === "update_issue" || g.op === "add_to_project") {
    const issue = await resolveIssue(ctx, callId, g.issue);
    if ("say" in issue) return issue.say;
    const n = issue.n;
    const board = await resolveBoard(ctx, g.project);
    const update = {
      ...(add.found.length ? { addAssignees: add.found.map((p) => p.login) } : {}),
      ...(remove.found.length ? { removeAssignees: remove.found.map((p) => p.login) } : {}),
      ...(labels.length ? { addLabels: labels } : {}),
      ...(g.state ? { state: g.state } : {}), ...(g.state === "closed" && g.stateReason ? { stateReason: g.stateReason } : {}),
      ...(g.comment.trim() ? { comment: g.comment.trim() } : {}), ...(g.title.trim() && g.op === "update_issue" ? { title: g.title.trim() } : {}),
    };
    const changes = Object.keys(update);
    const unknown = dontKnow([...add.unknown, ...remove.unknown]);
    if (!changes.length && !board.project) {
      if (add.unknown.length || remove.unknown.length) return `I don't know ${names([...add.unknown, ...remove.unknown].map((u) => `${u}'s`))} GitHub.`;
      return board.say.trim() || `What should I change on issue ${n}?`;
    }
    let i = 0;
    if (changes.length) await enqueueGithub(ctx, callId, speaker, "update_issue", { issue: n, ...update }, key("update_issue", i++));
    if (board.project) await enqueueGithub(ctx, callId, speaker, "add_to_project", { issue: n, project: board.project._id }, key("add_to_project", i++));
    const only = changes.length === 1 ? changes[0] : "";
    const what = !changes.length ? `putting issue ${n} on the ${board.project!.name} board`
      : update.state ? `${update.state === "closed" ? "closing" : "reopening"} issue ${n}`
      : only === "addAssignees" ? `assigning issue ${n} to ${names(add.found.map(first))}`
      : only === "comment" ? `commenting on issue ${n}`
      : only === "addLabels" ? `labeling issue ${n}`
      : `updating issue ${n}`;
    return `On it, ${what}.${unknown}${board.say}`;
  }
  return "";
}
