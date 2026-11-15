/**
 * Names the listener offers for "you" and "others": who is in the Google Meet right now (calls.liveParticipants, from
 * Recall join/leave events, worker roster.ts) first, then who has been in this call, then the rest of the team. Pure.
 */
type CallPeople = { liveParticipants?: { name?: unknown }[]; participants?: unknown[] } | null;

export function peopleChoices(call: CallPeople, team: string[], agentName = "Gomon"): { inCall: string[] | null; choices: string[] } {
  const clean = (xs: unknown[]) => xs.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== agentName.toLowerCase());
  const inCall = Array.isArray(call?.liveParticipants) ? clean(call.liveParticipants.map((p) => p?.name)) : null;
  const all = [...new Set([...(inCall ?? []), ...clean(call?.participants ?? []), ...clean(team)])];
  // "Max", "Rob" next to "Max Naidenov", "Robert Reder": a one-word name that starts a fuller name's first word is an alias.
  const alias = (n: string) => !n.includes(" ") && all.some((o) => o !== n && o.includes(" ") && o.split(" ")[0].toLowerCase().startsWith(n.toLowerCase()));
  return { inCall, choices: all.filter((n) => !alias(n)) };
}
