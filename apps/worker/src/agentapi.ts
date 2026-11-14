/**
 * The platform for agents (Max, Nov 14): read-only JSON an agent can search and query without the dashboard. Same data and
 * same code Gomon uses for its own context (platform.ts). Behind WORKER_TOKEN like every other /api route.
 *   GET /api/agent                         what is here and how the team works
 *   GET /api/agent/call?callId=            the meeting: Google Meet link, project, participants, summary, team, memory index, tickets (default: latest live call)
 *   GET /api/agent/memory?key=D-15         one memory, any project ("D15" works)
 *   GET /api/agent/memory?q=rate limits    search: key, then text match, across all projects
 *   GET /api/agent/tickets                 filed GitHub tickets (issue, link, memory key, status, who asked)
 *   GET /api/agent/calls                   recent calls with project, participants and summary
 *   GET /api/agent/transcript?callId=&limit=   what was said, oldest first
 *   GET /api/agent/people                  the team: names, aliases, roles, GitHub logins
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Cols } from "./db.ts";
import { KEY_KINDS, loadPlatform, platformFacts } from "./platform.ts";

const send = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
};
const normKey = (s: string) => { const m = /^([a-z])[\s-]?(\d{1,3})$/i.exec(s.trim()); return m ? `${m[1].toUpperCase()}-${m[2].padStart(2, "0")}` : null; };

export async function handleAgentApi(req: IncomingMessage, res: ServerResponse, url: URL, c: Cols, teamId: string): Promise<boolean> {
  if (!url.pathname.startsWith("/api/agent")) return false;
  if (req.method !== "GET") { send(res, 405, { error: "read-only" }); return true; }
  const path = url.pathname.replace(/\/$/, "");
  const latest = async () => String((await c.calls.find({ teamId }).sort({ startedAt: -1 }).limit(1).next())?._id ?? "");
  const callId = url.searchParams.get("callId") || (await latest());
  if (path === "/api/agent") {
    const v = await loadPlatform(c, teamId, callId);
    send(res, 200, {
      about: "Gomon: an AI teammate in Google Meet calls with governed team memory on MongoDB Atlas. Read-only agent API.",
      howItWorks: platformFacts(v).split("\n"),
      keyKinds: KEY_KINDS,
      endpoints: ["/api/agent/call?callId=", "/api/agent/memory?key=D-15", "/api/agent/memory?q=text", "/api/agent/tickets", "/api/agent/calls", "/api/agent/transcript?callId=&limit=50", "/api/agent/people"],
    });
    return true;
  }
  if (path === "/api/agent/call") { send(res, 200, await loadPlatform(c, teamId, callId)); return true; }
  if (path === "/api/agent/tickets") { send(res, 200, (await loadPlatform(c, teamId, callId)).tickets); return true; }
  if (path === "/api/agent/people") { send(res, 200, (await loadPlatform(c, teamId, callId)).team); return true; }
  if (path === "/api/agent/memory") {
    const v = await loadPlatform(c, teamId, callId);
    const key = normKey(url.searchParams.get("key") ?? url.searchParams.get("q") ?? "");
    if (key) { const m = v.memory.find((x) => x.key === key); send(res, m ? 200 : 404, m ?? { error: `${key} does not exist`, latest: v.memory.filter((x) => x.key[0] === key[0]).at(-1)?.key ?? null }); return true; }
    const words = (url.searchParams.get("q") ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const hits = v.memory.map((m) => ({ m, n: words.filter((w) => m.text.toLowerCase().includes(w)).length })).filter((x) => x.n).sort((a, b) => b.n - a.n).map((x) => x.m);
    send(res, 200, words.length ? hits.slice(0, 20) : v.memory);
    return true;
  }
  if (path === "/api/agent/calls") {
    const calls = await c.calls.find({ teamId }).sort({ startedAt: -1 }).limit(Number(url.searchParams.get("limit")) || 20)
      .project({ title: 1, projectId: 1, status: 1, startedAt: 1, endedAt: 1, participants: 1, meetingUrl: 1, summary: 1, utteranceSeq: 1 }).toArray();
    send(res, 200, calls.map(({ _id, ...x }) => ({ callId: _id, ...x })));
    return true;
  }
  if (path === "/api/agent/transcript") {
    const u = await c.utterances.find({ callId }).sort({ seq: -1 }).limit(Math.min(500, Number(url.searchParams.get("limit")) || 50)).project({ seq: 1, speaker: 1, text: 1, receivedAt: 1, source: 1 }).toArray();
    send(res, 200, { callId, lines: u.reverse().map((x) => ({ seq: x.seq, at: x.receivedAt, speaker: x.speaker?.displayName, text: x.text, source: x.source })) });
    return true;
  }
  send(res, 404, { error: "unknown agent endpoint", see: "/api/agent" });
  return true;
}
