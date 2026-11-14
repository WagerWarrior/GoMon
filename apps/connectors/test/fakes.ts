import http from "node:http";
import { MongoClient } from "mongodb";

export const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true";
export const TEAM = "northwind-platform", PROJECT = "public-api-launch";

export async function freshDb() {
  const c = new MongoClient(URI); await c.connect();
  const name = "ctest_" + Math.random().toString(36).slice(2, 10); const d = c.db(name);
  await d.collection("actions").createIndex({ idempotencyKey: 1 }, { unique: true });
  await d.collection("members").insertMany([{ teamId: TEAM, displayName: "Priya", role: "lead" }, { teamId: TEAM, displayName: "Lena", role: "observer" }]);
  await d.collection("policies").insertMany([{ teamId: TEAM, projectId: PROJECT, action: "create_issue", allowedRoles: ["lead"] }, { teamId: TEAM, projectId: PROJECT, action: "post_slack", allowedRoles: ["lead"] }]);
  await d.collection("calls").insertOne({ _id: "call-1" as any, teamId: TEAM, projectId: PROJECT, title: "Rate limits" });
  return { d, done: async () => { await d.dropDatabase(); await c.close(); } };
}
export async function queue(d: any, type: "create_issue" | "post_slack", over: any = {}) {
  const key = over.idempotencyKey ?? `${type}:call-1:${Math.random().toString(36).slice(2, 8)}`;
  const doc = { callId: "call-1", teamId: TEAM, projectId: PROJECT, type, requestedBy: "Priya", status: "queued", attempts: 0, createdAt: new Date(), idempotencyKey: key,
    payload: type === "create_issue" ? { title: "Tiered limits", body: "Locked decision", labels: ["decision"] } : { text: "Decision locked: tiered limits" }, ...over };
  const r = await d.collection("actions").insertOne(doc); return r.insertedId;
}

type Json = any;
export function fakeGithub() {
  const s = { issues: [] as Json[], posts: 0, lists: 0, failCreateAfterApply: 0, status: 0 as number, rateLimit: false, assigneeReject: false };
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const send = (code: number, j: Json, h: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(j)); };
      if (s.status) return send(s.status, { message: "Bad credentials" });
      if (s.rateLimit) return send(429, { message: "rate limit" }, { "retry-after": "1" });
      if (req.method === "POST" && /\/issues$/.test(req.url!)) {
        s.posts++; const j = JSON.parse(body);
        if (s.assigneeReject && j.assignees) return send(422, { message: "Validation Failed", errors: [{ field: "assignees" }] });
        const issue = { number: s.issues.length + 1, html_url: `http://gh.test/issues/${s.issues.length + 1}`, title: j.title, body: j.body, labels: j.labels };
        s.issues.push(issue);
        if (s.failCreateAfterApply > 0) { s.failCreateAfterApply--; return send(502, { message: "bad gateway" }); } // applied, then failed: the ambiguous case
        return send(201, issue);
      }
      if (req.method === "GET" && /\/issues\?/.test(req.url!)) { s.lists++; return send(200, [...s.issues].reverse()); }
      const m = /\/issues\/(\d+)$/.exec(req.url!);
      if (req.method === "GET" && m) { const i = s.issues[Number(m[1]) - 1]; return i ? send(200, i) : send(404, { message: "Not Found" }); }
      send(404, { message: "no route" });
    });
  });
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
