/**
 * Who is in the meeting, from Recall (Max, Nov 14). Until now a call's `participants` held only the names the listener was
 * told ("Start as") and people who spoke. Recall keeps the meeting's own participant list (name, host or not) with the bot's
 * recording; this reads it and adds the names to the call, so Gomon's PEOPLE line and the dashboard show who is really there.
 * Read-only towards Recall; on the call it only ever adds names (`$addToSet`), never removes or renames.
 * Runs as its own process (`npm run participants`), so it can be started and stopped without touching the worker.
 * `participantNames` is pure and tested in test/participants.test.ts.
 */
import type { Cols } from "./db.ts";
import { config } from "./config.ts";

type RecallParticipant = { name?: string | null; is_host?: boolean | null };
type BotJson = { recordings?: { media_shortcuts?: { participant_events?: { data?: { participants_download_url?: string | null } } } }[] };

/** Names of the people in the meeting: trimmed, once each, without the bot itself and without unnamed entries. Pure. */
export function participantNames(rows: unknown, botName = config.agentName): string[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows as RecallParticipant[]) {
    const name = typeof r?.name === "string" ? r.name.replace(/\s+/g, " ").trim() : "";
    const key = name.toLowerCase();
    if (!name || key === botName.toLowerCase() || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** The participant list Recall holds for a bot, or null when Recall has not released one yet. */
export async function meetingParticipants(botId: string, rc = config.recall): Promise<string[] | null> {
  if (!rc.apiKey) throw new Error("RECALL_API_KEY is not set");
  const r = await fetch(`https://${rc.region}.recall.ai/api/v1/bot/${encodeURIComponent(botId)}/`, { headers: { authorization: `Token ${rc.apiKey}`, accept: "application/json" }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`Recall ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const url = ((await r.json()) as BotJson).recordings?.[0]?.media_shortcuts?.participant_events?.data?.participants_download_url;
  if (!url) return null;
  const p = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!p.ok) return null;
  return participantNames(await p.json());
}

/**
 * One pass: every live call with a bot, and calls that ended in the last 15 minutes, get Recall's participants added.
 * Returns what was found per call (for the log). A call whose list is already recorded and unchanged is not written again.
 */
export async function sweepParticipants(c: Cols, now = new Date()): Promise<{ callId: string; names: string[] | null; added: number }[]> {
  const calls = await c.calls.find({
    teamId: config.teamId, botId: { $type: "string" },
    $or: [{ status: "live" }, { status: "ended", endedAt: { $gte: new Date(+now - 15 * 60_000) } }],
  }).project({ botId: 1, participants: 1 }).limit(10).toArray();
  const out: { callId: string; names: string[] | null; added: number }[] = [];
  for (const call of calls) {
    const callId = String(call._id);
    let names: string[] | null = null;
    try { names = await meetingParticipants(String(call.botId)); } catch (e) { console.error(`[participants] ${callId}:`, e instanceof Error ? e.message : e); }
    const have = new Set(((call.participants as string[] | undefined) ?? []).map((n) => n.toLowerCase()));
    const fresh = (names ?? []).filter((n) => !have.has(n.toLowerCase()));
    if (fresh.length) await c.calls.updateOne({ _id: callId as never }, { $addToSet: { participants: { $each: fresh } }, $set: { participantsFrom: "recall", participantsAt: now } });
    out.push({ callId, names, added: fresh.length });
  }
  return out;
}
