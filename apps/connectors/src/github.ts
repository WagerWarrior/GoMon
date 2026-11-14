import type { Db } from "mongodb";
import { Permanent, Retryable, type Action, type Env, type Sent } from "./types";

const MARK = (key: string) => `<!-- gomon-idempotency:${key} -->`;

function cfg(env: Env) {
  if (!env.GITHUB_TOKEN) throw new Permanent("GITHUB_TOKEN is not set");
  if (!env.GITHUB_REPO) throw new Permanent("GITHUB_REPO is not set");
  return { token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO, base: env.GITHUB_API_URL || "https://api.github.com" };
}
async function call(env: Env, method: string, path: string, body?: unknown) {
  const { token, base } = cfg(env);
  let res: Response;
  try {
    res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "gomon-connectors" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  } catch (e: any) { throw new Retryable(`network error: ${e?.message ?? e}`, method !== "GET"); }
  const text = await res.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { res, json, text };
}
function classify(res: Response, json: any, text: string, what: string): never {
  const msg = `${what}: HTTP ${res.status} ${json?.message ?? text.slice(0, 160)}`;
  const ra = Number(res.headers.get("retry-after"));
  if (res.status === 429 || (res.status === 403 && /rate limit/i.test(json?.message ?? ""))) throw new Retryable(msg, false, (ra || 30) * 1000);
  if (res.status >= 500) throw new Retryable(msg, true);   // the server may have applied the write before failing
  throw new Permanent(msg);                                // 401/403/404/422: retrying cannot help
}
/** REST call that must succeed; failures are classified Retryable/Permanent. */
async function rest(env: Env, method: string, path: string, body: unknown, what: string): Promise<any> {
  const r = await call(env, method, path, body);
  if (!r.res.ok) classify(r.res, r.json, r.text, what);
  return r.json;
}
/** GitHub GraphQL (Projects v2 has no REST API). Errors in a 200 response are permanent except rate limiting. */
async function gql<T = any>(env: Env, query: string, variables: Record<string, unknown>, what: string): Promise<T> {
  const r = await call(env, "POST", "/graphql", { query, variables });
  if (!r.res.ok) classify(r.res, r.json, r.text, what);
  const err = r.json?.errors?.[0];
  if (err) {
    if (err.type === "RATE_LIMITED") throw new Retryable(`${what}: ${err.message}`, false, 60000);
    throw new Permanent(`${what}: ${err.message}`);
  }
  return r.json.data as T;
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Look for an issue this action already created (identified by the marker in its body). Used before every retry. */
export async function findIssue(env: Env, key: string): Promise<(Sent & { nodeId?: string }) | null> {
  const { repo } = cfg(env);
  const { res, json, text } = await call(env, "GET", `/repos/${repo}/issues?state=all&labels=gomon&per_page=100&sort=created&direction=desc`);
  if (!res.ok) classify(res, json, text, "list issues");
  const hit = (json as any[]).find((i) => typeof i.body === "string" && i.body.includes(MARK(key)) && !i.pull_request);
  return hit ? { externalId: `${repo}#${hit.number}`, externalUrl: hit.html_url, nodeId: hit.node_id } : null;
}

/** Labels must exist before GitHub accepts them everywhere; create the missing ones (a concurrent create's 422 is fine). */
async function ensureLabels(env: Env, labels: string[]): Promise<void> {
  if (!labels.length) return;
  const { repo } = cfg(env);
  const have = new Set(((await rest(env, "GET", `/repos/${repo}/labels?per_page=100`, undefined, "list labels")) as any[]).map((l) => String(l.name).toLowerCase()));
  for (const name of labels.filter((l) => !have.has(l.toLowerCase()))) {
    const r = await call(env, "POST", `/repos/${repo}/labels`, { name, color: "ededed" });
    if (!r.res.ok && r.res.status !== 422) classify(r.res, r.json, r.text, `create label ${name}`);
  }
}

/** Milestone by title (case-insensitive), created if missing; a given due date is applied to an existing one too. */
async function milestone(env: Env, title: string, opts: { description?: string; dueOn?: string } = {}): Promise<{ number: number; html_url: string; title: string }> {
  const { repo } = cfg(env);
  const all = (await rest(env, "GET", `/repos/${repo}/milestones?state=all&per_page=100`, undefined, "list milestones")) as any[];
  const hit = all.find((m) => String(m.title).toLowerCase() === title.toLowerCase());
  if (hit) {
    if (opts.dueOn && String(hit.due_on ?? "").slice(0, 10) !== opts.dueOn.slice(0, 10)) return rest(env, "PATCH", `/repos/${repo}/milestones/${hit.number}`, { due_on: opts.dueOn }, "update milestone");
    return hit;
  }
  return rest(env, "POST", `/repos/${repo}/milestones`, { title, ...(opts.description ? { description: opts.description } : {}), ...(opts.dueOn ? { due_on: opts.dueOn } : {}) }, "create milestone");
}

export async function createIssue(env: Env, payload: Record<string, any>, key: string): Promise<Sent & { nodeId?: string }> {
  const { repo } = cfg(env);
  const labels = Array.from(new Set(["gomon", ...(payload.labels ?? [])]));
  const body = { title: String(payload.title ?? "Gomon decision").slice(0, 256), body: `${payload.body ?? ""}\n\n${MARK(key)}`, labels, ...(payload.assignees?.length ? { assignees: payload.assignees } : {}), ...(payload.milestoneNumber ? { milestone: payload.milestoneNumber } : {}) };
  let r = await call(env, "POST", `/repos/${repo}/issues`, body);
  let note: string | undefined;
  if (r.res.status === 422 && /assignee/i.test(JSON.stringify(r.json))) { // unknown login: file the issue unassigned rather than lose it, and say so
    const { assignees, ...rest } = body as any; r = await call(env, "POST", `/repos/${repo}/issues`, rest); note = "assignee rejected by GitHub; created unassigned";
  }
  if (!r.res.ok) classify(r.res, r.json, r.text, "create issue");
  return { externalId: `${repo}#${r.json.number}`, externalUrl: r.json.html_url, note, nodeId: r.json.node_id };
}

/** Read the issue back. A mismatch means the stored external ID does not point at what we meant to create. */
export async function confirmIssue(env: Env, externalId: string, key: string): Promise<boolean> {
  const { repo } = cfg(env); const n = externalId.split("#").pop();
  const { res, json } = await call(env, "GET", `/repos/${repo}/issues/${n}`);
  return res.ok && typeof json?.body === "string" && json.body.includes(MARK(key));
}

/** The Projects v2 board recorded on a Gomon project (`projects.github`), or a permanent error. */
async function boardOf(d: Db, teamId: string, project: unknown): Promise<{ projectId: string; url: string; projectNumber: number }> {
  const p: any = await d.collection("projects").findOne({ _id: String(project) as any, teamId });
  if (!p) throw new Permanent(`no Gomon project "${project}"`);
  if (!p.github?.projectId) throw new Permanent(`project "${p.name ?? project}" has no GitHub board yet`);
  return p.github;
}
/** Adding the same issue twice returns the existing item, so this is safe to repeat on retry. */
async function addToBoard(env: Env, boardId: string, contentId: string): Promise<string> {
  const data = await gql(env, `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}) { item { id } } }`, { p: boardId, c: contentId }, "add to board");
  return data.addProjectV2ItemById.item.id;
}

/**
 * Create an issue (outbox type create_issue, or github op create_issue): adopt the earlier attempt's issue on retry, make sure
 * labels exist, resolve the milestone by title, then add it to the Gomon project's board. Once the issue exists, a milestone or
 * board problem becomes a note, never a failure: failing would orphan an issue whose external ID we never stored.
 */
export async function sendIssue(d: Db, env: Env, a: Action): Promise<Sent> {
  const p = a.payload; const notes: string[] = [];
  let sent = (a.attempts ?? 1) > 1 ? await findIssue(env, a.idempotencyKey) : null;
  if (sent) notes.push("adopted earlier attempt");
  else {
    const labels = Array.from(new Set(["gomon", ...(p.labels ?? [])].map(String)));
    await ensureLabels(env, labels);
    let milestoneNumber: number | undefined;
    if (p.milestone) {
      try { milestoneNumber = (await milestone(env, String(p.milestone))).number; }
      catch (e) { if (!(e instanceof Permanent)) throw e; notes.push(`milestone not set (${e.message})`); }
    }
    sent = await createIssue(env, { ...p, labels, milestoneNumber }, a.idempotencyKey);
    if (sent.note) notes.push(sent.note);
  }
  if (p.project) {
    try {
      const board = await boardOf(d, a.teamId, p.project);
      const nodeId = sent.nodeId ?? (await rest(env, "GET", `/repos/${cfg(env).repo}/issues/${sent.externalId.split("#").pop()}`, undefined, "read issue")).node_id;
      await addToBoard(env, board.projectId, nodeId);
    } catch (e) { notes.push(`not added to board (${errText(e)})`); }
  }
  return { externalId: sent.externalId, externalUrl: sent.externalUrl, note: notes.join("; ") || undefined };
}

async function findComment(env: Env, n: number, key: string): Promise<string | null> {
  const { repo } = cfg(env);
  const list = (await rest(env, "GET", `/repos/${repo}/issues/${n}/comments?per_page=100`, undefined, "list comments")) as any[];
  return list.find((c) => typeof c.body === "string" && c.body.includes(MARK(key)))?.html_url ?? null;
}

function issueNumber(p: Record<string, any>): number {
  const n = Number(p.issue);
  if (!Number.isInteger(n) || n <= 0) throw new Permanent(`${p.op}: no issue number`);
  return n;
}

/**
 * update_issue: labels, assignees, comment, then state/title. Every step is naturally idempotent except the comment, which
 * carries the action's marker and is looked for before posting again on a retry. GitHub silently drops assignees it does not
 * know; those are noted.
 */
async function updateIssue(env: Env, a: Action): Promise<Sent> {
  const { repo } = cfg(env); const p = a.payload; const n = issueNumber(p); const notes: string[] = [];
  let url: string | undefined;
  if (p.addLabels?.length) { await ensureLabels(env, p.addLabels); await rest(env, "POST", `/repos/${repo}/issues/${n}/labels`, { labels: p.addLabels }, "add labels"); }
  if (p.addAssignees?.length) {
    const j = await rest(env, "POST", `/repos/${repo}/issues/${n}/assignees`, { assignees: p.addAssignees }, "add assignees");
    url = j?.html_url;
    const got = new Set(((j?.assignees ?? []) as any[]).map((x) => String(x.login).toLowerCase()));
    const missed = (p.addAssignees as string[]).filter((l) => !got.has(l.toLowerCase()));
    if (missed.length) notes.push(`assignee not accepted by GitHub: ${missed.join(", ")}`);
  }
  if (p.removeAssignees?.length) await rest(env, "DELETE", `/repos/${repo}/issues/${n}/assignees`, { assignees: p.removeAssignees }, "remove assignees");
  if (p.comment) {
    const prior = (a.attempts ?? 1) > 1 ? await findComment(env, n, a.idempotencyKey) : null;
    if (prior) notes.push("adopted earlier comment");
    url = prior ?? (await rest(env, "POST", `/repos/${repo}/issues/${n}/comments`, { body: `${p.comment}\n\n${MARK(a.idempotencyKey)}` }, "comment")).html_url;
  }
  if (p.state || p.title) {
    const j = await rest(env, "PATCH", `/repos/${repo}/issues/${n}`, { ...(p.state ? { state: p.state } : {}), ...(p.state === "closed" && p.stateReason ? { state_reason: p.stateReason } : {}), ...(p.title ? { title: String(p.title).slice(0, 256) } : {}) }, "update issue");
    url ??= j?.html_url;
  }
  if (!p.addLabels?.length && !p.addAssignees?.length && !p.removeAssignees?.length && !p.comment && !p.state && !p.title) throw new Permanent("update_issue: nothing to change");
  url ??= (await rest(env, "GET", `/repos/${repo}/issues/${n}`, undefined, "read issue")).html_url;
  return { externalId: `${repo}#${n}:update_issue:${a.idempotencyKey}`, externalUrl: url, note: notes.join("; ") || undefined };
}

const viewerCache = new Map<string, { id: string; login: string }>();
async function viewer(env: Env): Promise<{ id: string; login: string }> {
  const { token } = cfg(env);
  if (!viewerCache.has(token)) viewerCache.set(token, (await gql(env, `query { viewer { id login } }`, {}, "viewer")).viewer);
  return viewerCache.get(token)!;
}

/**
 * create_project: a Projects v2 board owned by the token's user (the repo owner is a personal account), linked to the repo when
 * GitHub allows it, recorded on the Gomon project as `projects.github`. A retry first adopts a board with the same title.
 */
async function createBoard(d: Db, env: Env, a: Action): Promise<Sent> {
  const p = a.payload; const notes: string[] = [];
  const projects = d.collection("projects");
  const proj: any = await projects.findOne({ _id: String(p.project) as any, teamId: a.teamId });
  if (!proj) throw new Permanent(`no Gomon project "${p.project}"`);
  const title = String(p.title || proj.name).slice(0, 120);
  const me = await viewer(env);
  if (proj.github?.projectId) return { externalId: `project:${me.login}/${proj.github.projectNumber}:${a.idempotencyKey}`, externalUrl: proj.github.url, note: "board already existed" };

  let board: { id: string; number: number; url: string; title: string } | undefined;
  if ((a.attempts ?? 1) > 1) {
    const data = await gql(env, `query { viewer { projectsV2(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { id number url title } } } }`, {}, "list boards");
    board = (data.viewer.projectsV2.nodes as any[]).find((b) => b.title === title);
    if (board) notes.push("adopted earlier attempt");
  }
  if (!board) {
    const data = await gql(env, `mutation($o:ID!,$t:String!){ createProjectV2(input:{ownerId:$o,title:$t}) { projectV2 { id number url title } } }`, { o: me.id, t: title }, "create board");
    board = data.createProjectV2.projectV2 as { id: string; number: number; url: string; title: string };
  }
  // Record it at once: the board exists now, and add_to_project / create_issue for this project need it.
  await projects.updateOne({ _id: proj._id, teamId: a.teamId }, { $set: { github: { projectNumber: board.number, projectId: board.id, url: board.url }, updatedAt: new Date() } });
  if (p.description) {
    try { await gql(env, `mutation($p:ID!,$d:String!){ updateProjectV2(input:{projectId:$p,shortDescription:$d}) { projectV2 { id } } }`, { p: board.id, d: String(p.description).slice(0, 300) }, "describe board"); }
    catch (e) { notes.push(`description not set (${errText(e)})`); }
  }
  try {
    const [owner, name] = cfg(env).repo.split("/");
    const repo = await gql(env, `query($o:String!,$n:String!){ repository(owner:$o,name:$n) { id } }`, { o: owner, n: name }, "repository id");
    await gql(env, `mutation($p:ID!,$r:ID!){ linkProjectV2ToRepository(input:{projectId:$p,repositoryId:$r}) { repository { id } } }`, { p: board.id, r: repo.repository.id }, "link board to repo");
  } catch (e) { notes.push(`not linked to repo (${errText(e)})`); }
  return { externalId: `project:${me.login}/${board.number}`, externalUrl: board.url, note: notes.join("; ") || undefined };
}

/** add_to_project: put an existing issue on a Gomon project's board (idempotent on GitHub's side). */
async function addIssueToProject(d: Db, env: Env, a: Action): Promise<Sent> {
  const { repo } = cfg(env); const n = issueNumber(a.payload);
  const board = await boardOf(d, a.teamId, a.payload.project);
  const issue = await rest(env, "GET", `/repos/${repo}/issues/${n}`, undefined, "read issue");
  await addToBoard(env, board.projectId, issue.node_id);
  return { externalId: `${repo}#${n}:add_to_project:${a.idempotencyKey}`, externalUrl: board.url };
}

/** create_milestone: find-or-create by title, so a repeat never makes a second "Beta". */
async function createMilestone(env: Env, a: Action): Promise<Sent> {
  const { repo } = cfg(env); const p = a.payload;
  if (!p.title) throw new Permanent("create_milestone: no title");
  const m = await milestone(env, String(p.title), { description: p.description, dueOn: p.dueOn });
  return { externalId: `${repo}:milestone/${m.number}:${a.idempotencyKey}`, externalUrl: m.html_url };
}

/** Outbox type "github" (contract 6): one op per action. */
export async function sendGithub(d: Db, env: Env, a: Action): Promise<Sent> {
  switch (a.payload.op) {
    case "create_issue": return sendIssue(d, env, a);
    case "update_issue": return updateIssue(env, a);
    case "create_project": return createBoard(d, env, a);
    case "add_to_project": return addIssueToProject(d, env, a);
    case "create_milestone": return createMilestone(env, a);
    default: throw new Permanent(`unknown github op ${a.payload.op}`);
  }
}

/** Cheap read-back per op; false leaves the action "sent". */
export async function confirmGithub(d: Db, env: Env, a: Action, sent: Sent): Promise<boolean> {
  const { repo } = cfg(env); const p = a.payload;
  if (p.op === "create_issue") return confirmIssue(env, sent.externalId, a.idempotencyKey);
  if (p.op === "update_issue") {
    const n = issueNumber(p);
    const { res, json } = await call(env, "GET", `/repos/${repo}/issues/${n}`);
    if (!res.ok) return false;
    const labels = new Set(((json.labels ?? []) as any[]).map((l) => String(typeof l === "string" ? l : l.name).toLowerCase()));
    if (p.state && json.state !== p.state) return false;
    if ((p.addLabels ?? []).some((l: string) => !labels.has(l.toLowerCase()))) return false;
    return p.comment ? (await findComment(env, n, a.idempotencyKey)) !== null : true;
  }
  if (p.op === "create_project") {
    const proj: any = await d.collection("projects").findOne({ _id: String(p.project) as any, teamId: a.teamId });
    if (!proj?.github?.projectId) return false;
    const data = await gql(env, `query($id:ID!){ node(id:$id) { ... on ProjectV2 { title } } }`, { id: proj.github.projectId }, "read board");
    return typeof data?.node?.title === "string";
  }
  if (p.op === "create_milestone") {
    const n = /milestone\/(\d+)/.exec(sent.externalId)?.[1];
    const { res, json } = await call(env, "GET", `/repos/${repo}/milestones/${n}`);
    return res.ok && String(json?.title).toLowerCase() === String(p.title).toLowerCase();
  }
  return false;
}
