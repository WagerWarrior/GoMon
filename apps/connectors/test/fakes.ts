import http from "node:http";
import { MongoClient } from "mongodb";

export const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true";
export const TEAM = "northwind-platform", PROJECT = "public-api-launch";

export async function freshDb() {
  const c = new MongoClient(URI); await c.connect();
  const name = "ctest_" + Math.random().toString(36).slice(2, 10); const d = c.db(name);
  await d.collection("actions").createIndex({ idempotencyKey: 1 }, { unique: true });
  await d.collection("members").insertMany([{ teamId: TEAM, displayName: "Priya", role: "lead" }, { teamId: TEAM, displayName: "Lena", role: "observer" }]);
  await d.collection("policies").insertMany([{ teamId: TEAM, projectId: PROJECT, action: "create_issue", allowedRoles: ["lead"] }, { teamId: TEAM, projectId: PROJECT, action: "post_slack", allowedRoles: ["lead"] },
    { teamId: TEAM, action: "github_write", allowedRoles: ["lead", "engineer"] }, { teamId: TEAM, action: "create_project", allowedRoles: ["lead", "engineer"] }]);
  await d.collection("calls").insertOne({ _id: "call-1" as any, teamId: TEAM, projectId: PROJECT, title: "Rate limits" });
  // Drop collection by collection: an Atlas user with readWrite (no dbAdmin) may not run dropDatabase.
  return { d, done: async () => { for (const x of await d.listCollections({}, { nameOnly: true }).toArray()) await d.collection(x.name).drop().catch(() => {}); await c.close(); } };
}
export async function queue(d: any, type: "create_issue" | "post_slack" | "github", over: any = {}) {
  const key = over.idempotencyKey ?? `${type}:call-1:${Math.random().toString(36).slice(2, 8)}`;
  const doc = { callId: "call-1", teamId: TEAM, projectId: PROJECT, type, requestedBy: "Priya", status: "queued", attempts: 0, createdAt: new Date(), idempotencyKey: key,
    payload: type === "create_issue" ? { title: "Tiered limits", body: "Locked decision", labels: ["decision"] } : type === "post_slack" ? { text: "Decision locked: tiered limits" } : {}, ...over };
  const r = await d.collection("actions").insertOne(doc); return r.insertedId;
}

type Json = any;
const BAD_GATEWAY = Symbol("502");
export function fakeGithub() {
  const s = {
    issues: [] as Json[], posts: 0, lists: 0, failCreateAfterApply: 0, status: 0 as number, rateLimit: false, assigneeReject: false,
    labels: ["gomon"] as string[], milestones: [] as Json[], comments: [] as Json[], failCommentAfterApply: 0, commentPosts: 0,
    /** Projects v2 boards owned by the viewer, items added to boards, board->repo links. */
    boards: [] as Json[], items: [] as Json[], links: [] as Json[], failCreateBoardAfterApply: 0, boardCreates: 0,
    /** Logins GitHub knows; others are silently dropped by the add-assignees endpoint (like real GitHub). null = all. */
    knownLogins: null as string[] | null,
  };
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const send = (code: number, j: Json, h: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(j)); };
      if (s.status) return send(s.status, { message: "Bad credentials" });
      if (s.rateLimit) return send(429, { message: "rate limit" }, { "retry-after": "1" });
      const url = req.url!; const j: Json = body ? JSON.parse(body) : {};
      if (req.method === "POST" && url === "/graphql") { const g = graphql(String(j.query), j.variables ?? {}); return g === BAD_GATEWAY ? send(502, { message: "bad gateway" }) : send(200, { data: g }); }
      if (req.method === "POST" && /\/issues$/.test(url)) {
        s.posts++;
        if (s.assigneeReject && j.assignees) return send(422, { message: "Validation Failed", errors: [{ field: "assignees" }] });
        const n = s.issues.length + 1;
        const issue = { number: n, node_id: `I_${n}`, html_url: `http://gh.test/issues/${n}`, title: j.title, body: j.body, labels: j.labels, assignees: (j.assignees ?? []).map((login: string) => ({ login })), milestone: j.milestone ? { number: j.milestone } : null, state: "open" };
        s.issues.push(issue);
        if (s.failCreateAfterApply > 0) { s.failCreateAfterApply--; return send(502, { message: "bad gateway" }); } // applied, then failed: the ambiguous case
        return send(201, issue);
      }
      if (req.method === "GET" && /\/issues\?/.test(url)) { s.lists++; return send(200, [...s.issues].reverse()); }
      if (/\/labels\?/.test(url) && req.method === "GET") return send(200, s.labels.map((name) => ({ name })));
      if (/\/repos\/[^/]+\/[^/]+\/labels$/.test(url) && req.method === "POST") { if (s.labels.includes(j.name)) return send(422, { message: "already_exists" }); s.labels.push(j.name); return send(201, { name: j.name }); }
      if (/\/milestones\?/.test(url) && req.method === "GET") return send(200, s.milestones);
      if (/\/milestones$/.test(url) && req.method === "POST") { const m = { number: s.milestones.length + 1, title: j.title, due_on: j.due_on ?? null, html_url: `http://gh.test/milestone/${s.milestones.length + 1}` }; s.milestones.push(m); return send(201, m); }
      const ms = /\/milestones\/(\d+)$/.exec(url);
      if (ms) { const m = s.milestones[Number(ms[1]) - 1]; if (!m) return send(404, { message: "Not Found" }); if (req.method === "PATCH") Object.assign(m, j); return send(200, m); }
      const m = /\/issues\/(\d+)(\/[a-z]+)?(\?.*)?$/.exec(url);
      const issue = m ? s.issues[Number(m[1]) - 1] : undefined;
      if (m && !issue) return send(404, { message: "Not Found" });
      if (m && !m[2]) {
        if (req.method === "PATCH") { if (j.state) issue.state = j.state; if (j.state_reason) issue.state_reason = j.state_reason; if (j.title) issue.title = j.title; }
        return send(200, issue);
      }
      if (m && m[2] === "/labels" && req.method === "POST") { issue.labels = [...new Set([...(issue.labels ?? []), ...j.labels])]; return send(200, issue.labels.map((name: string) => ({ name }))); }
      if (m && m[2] === "/assignees") {
        const have = new Set((issue.assignees ?? []).map((a: Json) => a.login));
        if (req.method === "POST") for (const l of j.assignees) { if (!s.knownLogins || s.knownLogins.includes(l)) have.add(l); }
        if (req.method === "DELETE") for (const l of j.assignees) have.delete(l);
        issue.assignees = [...have].map((login) => ({ login }));
        return send(201, issue);
      }
      if (m && m[2] === "/comments") {
        if (req.method === "GET") return send(200, s.comments.filter((c) => c.issue === issue.number));
        s.commentPosts++;
        const c = { id: s.comments.length + 1, issue: issue.number, body: j.body, html_url: `http://gh.test/issues/${issue.number}#comment-${s.comments.length + 1}` };
        s.comments.push(c);
        if (s.failCommentAfterApply > 0) { s.failCommentAfterApply--; return send(502, { message: "bad gateway" }); }
        return send(201, c);
      }
      send(404, { message: "no route" });
    });
  });
  /** Just enough of GitHub GraphQL for Projects v2: matched by the operation name in the query text. */
  function graphql(q: string, v: Json): Json {
    if (q.includes("createProjectV2")) {
      s.boardCreates++;
      const n = s.boards.length + 1; const b = { id: `PVT_${n}`, number: n, url: `http://gh.test/users/robot/projects/${n}`, title: v.t, owner: v.o };
      s.boards.push(b);
      if (s.failCreateBoardAfterApply > 0) { s.failCreateBoardAfterApply--; return BAD_GATEWAY; } // applied, then failed
      return { createProjectV2: { projectV2: b } };
    }
    if (q.includes("projectsV2(")) return { viewer: { projectsV2: { nodes: [...s.boards].reverse() } } };
    if (q.includes("viewer")) return { viewer: { id: "U_robot", login: "robot" } };
    if (q.includes("updateProjectV2")) { const b = s.boards.find((x) => x.id === v.p); if (b) b.shortDescription = v.d; return { updateProjectV2: { projectV2: { id: v.p } } }; }
    if (q.includes("repository(")) return { repository: { id: `R_${v.o}/${v.n}` } };
    if (q.includes("linkProjectV2ToRepository")) { s.links.push({ board: v.p, repo: v.r }); return { linkProjectV2ToRepository: { repository: { id: v.r } } }; }
    if (q.includes("addProjectV2ItemById")) {
      if (!s.items.some((i) => i.board === v.p && i.content === v.c)) s.items.push({ board: v.p, content: v.c });
      return { addProjectV2ItemById: { item: { id: `PVTI_${v.p}_${v.c}` } } };
    }
    if (q.includes("node(")) { const b = s.boards.find((x) => x.id === v.id); return { node: b ? { title: b.title } : null }; }
    throw new Error(`fake graphql: unknown query ${q.slice(0, 60)}`);
  }
  return start(srv, s);
}
export function fakeSlack() {
  const s = { msgs: [] as Json[], posts: 0, failAfterApply: 0, error: "", hideReads: false };
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const send = (j: Json, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      const method = req.url!.split("/").pop()!; const form = String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded");
      // Like real Slack: read methods (conversations.*) ignore JSON bodies and need form encoding.
      if (method.startsWith("conversations.") && !form) return send({ ok: false, error: "invalid_arguments" });
      const j: Json = form ? Object.fromEntries(new URLSearchParams(body)) : body ? JSON.parse(body) : {};
      if (s.error) return send({ ok: false, error: s.error });
      if (s.hideReads && method!.startsWith("conversations.")) return send({ ok: false, error: "not_in_channel" });
      if (method === "chat.postMessage") {
        s.posts++; const ts = `${1700000000 + s.msgs.length}.000100`;
        s.msgs.push({ ts, text: j.text, thread_ts: j.thread_ts, metadata: j.metadata, channel: j.channel });
        if (s.failAfterApply > 0) { s.failAfterApply--; return send({}, 500); }
        return send({ ok: true, channel: j.channel, ts });
      }
      if (method === "conversations.history") return send({ ok: true, messages: s.msgs.filter((m) => !m.thread_ts).reverse() });
      if (method === "conversations.replies") return send({ ok: true, messages: s.msgs.filter((m) => m.thread_ts === j.ts || m.ts === j.ts) });
      send({ ok: false, error: "unknown_method" });
    });
  });
  return start(srv, s);
}
function start<T>(srv: http.Server, state: T): Promise<{ url: string; state: T; close: () => Promise<void> }> {
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(srv.address() as any).port}`, state, close: () => new Promise<void>((r) => srv.close(() => r())) })));
}
