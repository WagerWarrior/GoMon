/**
 * Spoken names -> GitHub logins. `members.githubLogin` (and `users.githubLogin`) is the only source: a name with no login, or
 * one that matches two people, resolves to nothing so Gomon says it doesn't know rather than guessing.
 */
import type { Ctx } from "./governance.ts";

export type Person = { display: string; login: string; names: string[] };

/** Team people that have a GitHub login, with every name they go by (lowercase; full names and first names). */
export async function loadPeople(ctx: Ctx): Promise<Person[]> {
  const [members, users] = await Promise.all([
    ctx.c.members.find({ teamId: ctx.teamId }, { projection: { displayName: 1, githubLogin: 1 } }).toArray(),
    ctx.c.users.find({ teamId: ctx.teamId }, { projection: { name: 1, displayNames: 1, githubLogin: 1 } }).toArray(),
  ]);
  const byLogin = new Map<string, Person>();
  const add = (login: unknown, names: unknown[]) => {
    if (typeof login !== "string" || !login) return;
    const p = byLogin.get(login.toLowerCase()) ?? { display: "", login, names: [] };
    for (const n of names) {
      if (typeof n !== "string" || !n.trim()) continue;
      const full = n.trim();
      if (!p.display || full.length < p.display.length) p.display = full;
      p.names.push(full.toLowerCase(), full.split(/\s+/)[0].toLowerCase());
    }
    p.names = [...new Set(p.names)];
    byLogin.set(login.toLowerCase(), p);
  };
  for (const m of members) add(m.githubLogin, [m.displayName]);
  for (const u of users) add(u.githubLogin, [u.name, ...((u.displayNames as unknown[] | undefined) ?? [])]);
  return [...byLogin.values()];
}

/** "Max", "max naidenov", "@naidx0", "me" -> one person, or null when unknown or ambiguous. */
export function resolvePerson(people: Person[], spoken: string, speaker: string): Person | null {
  let n = spoken.trim().replace(/^@/, "").toLowerCase();
  if (["me", "myself", "i"].includes(n)) n = speaker.toLowerCase();
  const find = (q: string) => people.filter((p) => p.names.includes(q) || p.login.toLowerCase() === q);
  let hits = find(n);
  if (!hits.length && n.includes(" ")) hits = find(n.split(/\s+/)[0]);
  return hits.length === 1 ? hits[0] : null;
}

/** People named in free text ("Max owns the rollout"), by whole-word match. */
export function peopleIn(text: string, people: Person[]): Person[] {
  return people.filter((p) => p.names.some((n) => n.length >= 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)));
}
