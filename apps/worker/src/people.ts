/**
 * Spoken names -> GitHub logins. `members.githubLogin` (and `users.githubLogin`) is the only source: a name with no login, or
 * one that matches two people, resolves to nothing so Gomon says it doesn't know rather than guessing.
 * Names are learned (Max, Nov 14): speech-to-text misspells people ("Nade X0" for naidx0, live in call-202611142054-291b, and
 * Gomon answered "I don't know Nade X0's GitHub"). A spoken name that sounds like exactly one person resolves to them and is
 * saved on that person as an alias (`members.aliases` / `users.aliases`), so the next time it is an exact match. `keyterms`
 * gives the same names to Scribe so they are spelled right at the source.
 */
import type { Ctx } from "./governance.ts";

/** display: the shortest name (spoken: "filing it for Rob"); full: the longest (lists and transcripts: "Robert Reder"). */
export type Person = { display: string; full?: string; login: string; names: string[] };

/** Team people that have a GitHub login, with every name they go by (lowercase; full names and first names). */
export async function loadPeople(ctx: Pick<Ctx, "c" | "teamId">): Promise<Person[]> {
  const [members, users] = await Promise.all([
    ctx.c.members.find({ teamId: ctx.teamId }, { projection: { displayName: 1, githubLogin: 1, aliases: 1 } }).toArray(),
    ctx.c.users.find({ teamId: ctx.teamId }, { projection: { name: 1, displayNames: 1, githubLogin: 1, aliases: 1 } }).toArray(),
  ]);
  const byLogin = new Map<string, Person>();
  const add = (login: unknown, names: unknown[]) => {
    if (typeof login !== "string" || !login) return;
    const p = byLogin.get(login.toLowerCase()) ?? { display: "", login, names: [] };
    for (const n of names) {
      if (typeof n !== "string" || !n.trim()) continue;
      const full = n.trim();
      if (!p.display || full.length < p.display.length) p.display = full;
      if (!p.full || full.length > p.full.length) p.full = full;
      p.names.push(full.toLowerCase(), full.split(/\s+/)[0].toLowerCase());
    }
    p.names = [...new Set(p.names)];
    byLogin.set(login.toLowerCase(), p);
  };
  for (const m of members) add(m.githubLogin, [m.displayName]);
  for (const u of users) add(u.githubLogin, [u.name, ...((u.displayNames as unknown[] | undefined) ?? [])]);
  // Learned mishearings match as whole strings only (no first-name split: "nade x0" must not add "nade").
  for (const d of [...members, ...users]) {
    const p = typeof d.githubLogin === "string" ? byLogin.get(d.githubLogin.toLowerCase()) : undefined;
    if (p && Array.isArray(d.aliases)) p.names = [...new Set([...p.names, ...d.aliases.filter((a): a is string => typeof a === "string")])];
  }
  return [...byLogin.values()];
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/**
 * The one person a misspelled name sounds like, or null. Letters and digits only ("Nade X0" -> "nadex0"), at least 4 of
 * them, within 2 edits of a login or name (1 edit for short ones), and strictly closer to that person than to anyone else.
 */
export function soundsLikePerson(people: Person[], spoken: string): Person | null {
  const q = squash(spoken);
  if (q.length < 4) return null;
  const limit = q.length >= 6 ? 2 : 1;
  const scored = people.map((p) => ({ p, d: Math.min(...[p.login, ...p.names].map((n) => distance(q, squash(n)))) })).sort((a, b) => a.d - b.d);
  const best = scored[0];
  if (!best || best.d > limit || (scored[1] && scored[1].d === best.d)) return null;
  return best.p;
}

/** Save a mishearing on the person it resolved to, and record it. The next call resolves it as an exact name. */
export async function learnAlias(ctx: Ctx, person: Person, spoken: string, callId?: string): Promise<void> {
  const alias = spoken.trim().replace(/^@/, "").toLowerCase();
  if (!alias || person.names.includes(alias)) return;
  const m = await ctx.c.members.updateOne({ teamId: ctx.teamId, githubLogin: person.login }, { $addToSet: { aliases: alias } });
  if (!m.matchedCount) await ctx.c.users.updateOne({ teamId: ctx.teamId, githubLogin: person.login }, { $addToSet: { aliases: alias } });
  await ctx.c.agentEvents.insertOne({ callId, teamId: ctx.teamId, projectId: ctx.projectId, at: new Date(), kind: "alias_learned", heard: alias, person: person.display, login: person.login });
}

/** Names Scribe should spell right: people, their GitHub logins, projects and the agent's own name. At most 40 short terms. */
export async function keyterms(ctx: Pick<Ctx, "c" | "teamId">): Promise<string[]> {
  const [people, projects] = await Promise.all([
    loadPeople(ctx),
    ctx.c.projects.find({ teamId: ctx.teamId, status: "active" }, { projection: { name: 1 } }).toArray(),
  ]);
  const members = await ctx.c.members.find({ teamId: ctx.teamId }, { projection: { displayName: 1 } }).toArray();
  const terms = ["Gomon", ...members.map((m) => String(m.displayName ?? "")), ...people.flatMap((p) => [p.display, p.login]), ...projects.map((p) => String(p.name ?? ""))];
  return [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 40))].slice(0, 40);
}

/** "Max", "max naidenov", "@naidx0", "me" -> one person, or null when unknown or ambiguous. */
export function resolvePerson(people: Person[], spoken: string, speaker: string): Person | null {
  let n = spoken.trim().replace(/^@/, "").toLowerCase();
  if (["me", "myself", "i"].includes(n)) n = speaker.toLowerCase();
  const find = (q: string) => people.filter((p) => p.names.includes(q) || p.login.toLowerCase() === q);
  let hits = find(n);
  if (!hits.length && n.includes(" ")) hits = find(n.split(/\s+/)[0]);
  if (hits.length === 1) return hits[0];
  return hits.length ? null : soundsLikePerson(people, n);
}

/** People named in free text ("Max owns the rollout"), by whole-word match. */
export function peopleIn(text: string, people: Person[]): Person[] {
  return people.filter((p) => p.names.some((n) => n.length >= 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)));
}
