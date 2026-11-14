/**
 * Gomon's fixed facts and the team's records, read the same way every time (Max, Nov 14, after the demo): it said "I don't
 * have details in this workspace" about D-15 (another project), "outstanding tickets" and "who is on this call". Everything an
 * agent needs to act like a teammate is loaded here as plain data: the meeting (Google Meet, title, project, participants),
 * the team (people, roles, GitHub logins, projects), every active memory key in every project, and the tickets (GitHub issues
 * and what Gomon filed). context.ts turns it into prompt lines; agentapi.ts serves it as JSON.
 */
import type { Cols } from "./db.ts";
import { PREFIX } from "./governance.ts";

export const KEY_KINDS: Record<string, string> = Object.fromEntries(Object.entries(PREFIX).map(([kind, p]) => [p, kind.replace("_", " ")]));

export type Person = { name: string; aliases: string[]; role: string; github: string | null };
export type PlatformView = {
  meeting: { callId: string; title: string; platform: "Google Meet"; meetingUrl: string | null; status: string; startedAt: string | null; minutesIn: number; project: { id: string; name: string; description: string }; participants: { name: string; role: string | null; github: string | null }[]; summary: string };
  team: { id: string; name: string; people: Person[]; projects: { id: string; name: string; description: string; memories: number }[] };
  memory: { key: string; kind: string; project: string; projectName: string; version: number; text: string }[];
  atlas: { database: string; counts: Record<string, number>; search: string[] };
  tickets: { repo: string; issuesUrl: string; filed: { kind: "GitHub issue" | "Slack post" | "notes file"; issue: string; url: string; memoryKey: string | null; title: string; status: string; requestedBy: string; at: string | null }[] };
};

const repo = () => process.env.GITHUB_REPO || "WagerWarrior/MongoDB";
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);

export async function loadPlatform(c: Cols, teamId: string, callId: string): Promise<PlatformView> {
  const counted = { calls: c.calls, utterances: c.utterances, call_items: c.callItems, memories: c.memories, actions: c.actions, audit_events: c.auditEvents, artifacts: c.artifacts } as const;
  const [call, team, members, projects, memories, actions, counts] = await Promise.all([
    c.calls.findOne({ _id: callId as never }),
    c.teams.findOne({ _id: teamId as never }),
    c.members.find({ teamId }).toArray(),
    c.projects.find({ teamId }).toArray(),
    c.memories.find({ teamId, status: "active", key: { $type: "string" } }).project({ key: 1, kind: 1, projectId: 1, version: 1, text: 1 }).toArray(),
    c.actions.find({ teamId, externalId: { $type: "string" } }).sort({ createdAt: -1 }).limit(15).toArray(),
    Promise.all(Object.entries(counted).map(async ([name, col]) => [name, await col.estimatedDocumentCount().catch(() => 0)] as const)),
  ]);
  // One person per GitHub login (seed has "Rob" and "Robert Reder" as two rows).
  const people = new Map<string, Person>();
  for (const m of members) {
    const k = String(m.githubLogin ?? m.displayName);
    const p = people.get(k) ?? { name: String(m.displayName), aliases: [], role: String(m.role ?? "member"), github: m.githubLogin ? String(m.githubLogin) : null };
    const n = String(m.displayName);
    if (n.length > p.name.length) { p.aliases.push(p.name); p.name = n; } else if (n !== p.name) p.aliases.push(n);
    for (const a of (m.aliases as string[] | undefined) ?? []) if (!p.aliases.includes(a)) p.aliases.push(a);
    people.set(k, p);
  }
  const who = (name: string) => [...people.values()].find((p) => p.name === name || p.aliases.includes(name) || name.startsWith(`${p.name} `) || p.name.startsWith(`${name} `));
  const pname = new Map(projects.map((p) => [String(p._id), String(p.name ?? p._id)]));
  const keyOf = new Map(memories.map((m) => [String(m._id), String(m.key)]));
  const proj = projects.find((p) => p._id === call?.projectId);
  const started = call?.startedAt instanceof Date ? call.startedAt : null;
  const order = (k: string) => [k[0], Number(k.split("-")[1] ?? 0)] as const;
  return {
    meeting: {
      callId, title: String(call?.title ?? "untitled"), platform: "Google Meet", meetingUrl: call?.meetingUrl ? String(call.meetingUrl) : null,
      status: String(call?.status ?? "unknown"), startedAt: iso(started), minutesIn: started ? Math.max(0, Math.round((Date.now() - started.getTime()) / 60_000)) : 0,
      project: { id: String(call?.projectId ?? ""), name: String(proj?.name ?? call?.projectId ?? "?"), description: String(proj?.description ?? "") },
      participants: ((call?.participants as string[] | undefined) ?? []).map((n) => { const p = who(n); return { name: n, role: p?.role ?? null, github: p?.github ?? null }; }),
      summary: typeof call?.summary === "string" ? call.summary : "",
    },
    team: {
      id: teamId, name: String(team?.name ?? teamId), people: [...people.values()],
      projects: projects.map((p) => ({ id: String(p._id), name: String(p.name ?? p._id), description: String(p.description ?? ""), memories: memories.filter((m) => m.projectId === p._id).length })),
    },
    memory: memories
      .map((m) => ({ key: String(m.key), kind: String(m.kind), project: String(m.projectId), projectName: pname.get(String(m.projectId)) ?? String(m.projectId), version: Number(m.version ?? 1), text: String(m.text) }))
      .sort((a, b) => { const [pa, na] = order(a.key); const [pb, nb] = order(b.key); return pa === pb ? na - nb : pa < pb ? -1 : 1; }),
    atlas: {
      database: c.calls.dbName, counts: Object.fromEntries(counts),
      search: ["memories_auto ($vectorSearch, Voyage voyage-4 by Atlas Automated Embedding)", "memories_text ($search, lexical)", "utterances_auto, calls_auto, artifacts_auto ($vectorSearch over transcripts, summaries, ADRs)"],
    },
    tickets: {
      repo: repo(), issuesUrl: `https://github.com/${repo()}/issues`,
      filed: actions.map((a) => {
        const p = (a.payload ?? {}) as Record<string, unknown>;
        const title = String(p.title ?? p.text ?? a.type);
        const id = String(a.externalId);
        return {
          // The outbox also posts recaps to Slack and writes call notes to the records branch: those are not tickets.
          kind: /#\d+$/.test(id) ? "GitHub issue" as const : String(a.type).includes("slack") ? "Slack post" as const : "notes file" as const,
          issue: id, url: String(a.externalUrl ?? ""), title, status: String(a.status), requestedBy: String(a.requestedBy ?? "?"), at: iso(a.createdAt),
          memoryKey: (a.memoryId && keyOf.get(String(a.memoryId))) || /^([A-Z]-\d+):/.exec(title)?.[1] || null,
        };
      }),
    },
  };
}

/** The fixed facts, written for the model. Pure. */
export function platformFacts(v: PlatformView, agentName = "Gomon"): string {
  const m = v.meeting;
  const people = v.team.people.map((p) => `${p.name} (${p.role}${p.github ? `, GitHub ${p.github}` : ""})`).join("; ");
  const latest = Object.keys(KEY_KINDS).map((pfx) => v.memory.filter((x) => x.key.startsWith(`${pfx}-`)).at(-1)?.key).filter(Boolean).join(", ");
  return [
    `WHERE YOU ARE: a live Google Meet call. You are ${agentName}, the team's AI teammate, in the call as a bot participant named "${agentName}" (joined through Recall.ai). You hear a live transcript of everyone and speak out loud; links go in the Meet chat.`,
    `THIS CALL: "${m.title}"${m.meetingUrl ? ` (${m.meetingUrl})` : ""}, project "${m.project.name}"${m.project.description ? `: ${m.project.description}` : ""}. You joined about ${m.minutesIn} minute${m.minutesIn === 1 ? "" : "s"} ago.`,
    `PEOPLE WHO HAVE SPOKEN ON THIS CALL: ${m.participants.length ? m.participants.map((p) => `${p.name}${p.role ? ` (${p.role})` : ""}`).join(", ") : "nobody yet"}. Others may be listening without speaking.`,
    `TEAM ${v.team.name}: ${people}. Projects: ${v.team.projects.map((p) => `"${p.name}" (${p.memories} memories)`).join(", ")}.`,
    `TEAM MEMORY KEYS: every locked item has a key by kind (${Object.entries(KEY_KINDS).map(([p, k]) => `${p}- ${k}`).join(", ")}), unique across all projects. People say keys without the dash and call them tickets: "D17" or "ticket D 15" means memory key D-17 / D-15. Latest keys: ${latest || "none"}. MEMORY INDEX lists every one.`,
    `GITHUB TICKETS: issues in ${v.tickets.repo} (${v.tickets.issuesUrl}). You file them from memory when asked ("create the tickets" files every decision locked on this call; "turn D-09 into an issue" files one), titled "<key>: <text>", after a policy check, once per memory version, then you post the link. FILED TICKETS lists what you filed.`,
    `MONGODB ATLAS: database "${v.atlas.database}" is the single source of truth. Right now it holds ${Object.entries(v.atlas.counts).map(([k, n]) => `${n} ${k}`).join(", ")}. ${v.memory.length} memories are active. Search indexes: ${v.atlas.search.join("; ")}.`,
    `HOW DECISIONS LOCK: when people agree you announce it, anyone can say "wait" within 10 s, then it gets the next key. "Lock it in" locks at once. Corrections and "forget" keep history.`,
  ].join("\n");
}

/** Records as source lines (id + line), memory index first. Pure. */
export function platformSources(v: PlatformView): { id: string; line: string }[] {
  return [
    ...v.tickets.filed.map((t) => ({ id: `#${t.issue.split("#")[1] ?? t.issue}`, line: `${t.kind === "GitHub issue" ? `filed ticket ${t.issue}` : `${t.kind} you made`}${t.memoryKey ? ` from ${t.memoryKey}` : ""} [${t.status}] "${t.title.replace(/\s+/g, " ").slice(0, 90)}" by ${t.requestedBy}${t.at ? ` on ${t.at.slice(0, 10)}` : ""} ${t.url}` })),
    ...v.memory.map((m) => ({ id: m.key, line: `memory ${m.key} [${m.projectName}] ${m.kind} v${m.version}: ${m.text.length > 150 ? `${m.text.slice(0, 149)}…` : m.text}` })),
  ];
}
