/**
 * Real speaker names (Max, Nov 14). The no-tunnel listener (ears) knows two voices only: the laptop mic ("you") and the
 * meeting tab ("others"), so everyone remote shares one name. Recall knows who spoke when, by participant name, but without
 * a public URL it releases that only once the bot has left: the speaker timeline of a live bot is null (checked on a live and
 * a finished bot, Nov 14). So when a call ends, each transcript line is matched to the person who held the floor while it
 * was said and renamed; the label it was heard under stays on the utterance as `speaker.heardAs`.
 * Live names need Recall's realtime transcript, which needs PUBLIC_BASE_URL (recall.ts already runs that mode).
 * `speakerFor` is pure and tested in test/speakers.test.ts.
 */
import type { Cols } from "./db.ts";
import { config } from "./config.ts";

export type Span = { name: string; start: number; end: number };

/** Scribe commits a turn about this long after the last word (0.6 s of silence plus the round trip). */
const COMMIT_LAG_MS = 1000;
const MS_PER_WORD = 330;
const SLACK_MS = 700;
const MIN_OVERLAP_MS = 300;

/**
 * Who held the floor while a segment was spoken. `endedAt` is when the segment was committed (ms epoch), `words` its length.
 * The person with the most speaking time inside the segment's estimated window wins; null when nobody clearly does.
 */
export function speakerFor(spans: Span[], endedAt: number, words: number, skip: string[] = []): string | null {
  const to = endedAt - COMMIT_LAG_MS + SLACK_MS;
  const from = endedAt - COMMIT_LAG_MS - Math.max(1, words) * MS_PER_WORD - SLACK_MS;
  const time = new Map<string, number>();
  for (const s of spans) {
    if (skip.includes(s.name)) continue;
    const overlap = Math.min(s.end, to) - Math.max(s.start, from);
    if (overlap > 0) time.set(s.name, (time.get(s.name) ?? 0) + overlap);
  }
  const ranked = [...time].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < MIN_OVERLAP_MS) return null;
  // Two people talking the same amount in that window: leave the line as it was heard.
  if (ranked[1] && ranked[1][1] >= ranked[0][1] * 0.8) return null;
  return ranked[0][0];
}

type TimelineRow = { participant?: { name?: string | null }; start_timestamp?: { absolute?: string }; end_timestamp?: { absolute?: string } };
type BotJson = { recordings?: { media_shortcuts?: { participant_events?: { data?: { speaker_timeline_download_url?: string | null } } } }[] };

/** Recall's speaker timeline for a bot, or null while the recording is still being processed (always, during the call). */
export async function speakerTimeline(botId: string, rc = config.recall): Promise<Span[] | null> {
  if (!rc.apiKey) throw new Error("RECALL_API_KEY is not set");
  const r = await fetch(`https://${rc.region}.recall.ai/api/v1/bot/${encodeURIComponent(botId)}/`, { headers: { authorization: `Token ${rc.apiKey}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Recall ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const url = ((await r.json()) as BotJson).recordings?.[0]?.media_shortcuts?.participant_events?.data?.speaker_timeline_download_url;
  if (!url) return null;
  const t = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!t.ok) throw new Error(`Recall timeline ${t.status}`);
  return ((await t.json()) as TimelineRow[]).flatMap((row) => {
    const name = row.participant?.name?.trim();
    const start = Date.parse(row.start_timestamp?.absolute ?? ""), end = Date.parse(row.end_timestamp?.absolute ?? "");
    return name && Number.isFinite(start) && Number.isFinite(end) ? [{ name, start, end }] : [];
  });
}

export type Relabel = { status: "done" | "not_ready" | "no_bot"; total: number; renamed: number; people: string[] };

/** Rename this call's spoken lines to the people Recall heard. `dryRun` reports without writing. */
export async function relabelSpeakers(c: Cols, callId: string, opts: { dryRun?: boolean } = {}): Promise<Relabel> {
  const call = await c.calls.findOne({ _id: callId as never }, { projection: { botId: 1, teamId: 1, projectId: 1 } });
  const botId = typeof call?.botId === "string" ? call.botId : "";
  if (!botId) return { status: "no_bot", total: 0, renamed: 0, people: [] };
  const spans = await speakerTimeline(botId);
  // No rows yet (still processing) or nobody was unmuted in the Meet: nothing to go on, try again on the next sweep.
  if (!spans?.length) return { status: "not_ready", total: 0, renamed: 0, people: [] };
  const skip = [config.agentName];
  const people = [...new Set(spans.map((s) => s.name))].filter((n) => !skip.includes(n));
  const lines = await c.utterances.find({ callId, source: { $ne: "typed" } }).project({ text: 1, speaker: 1, receivedAt: 1 }).toArray();
  let renamed = 0;
  for (const u of lines) {
    const at = u.receivedAt instanceof Date ? u.receivedAt.getTime() : NaN;
    const who = Number.isFinite(at) ? speakerFor(spans, at, String(u.text ?? "").split(/\s+/).filter(Boolean).length, skip) : null;
    const was = String((u.speaker as { displayName?: string } | undefined)?.displayName ?? "");
    if (!who || who === was) continue;
    renamed++;
    if (!opts.dryRun) await c.utterances.updateOne({ _id: u._id }, { $set: { "speaker.displayName": who, "speaker.heardAs": was, speakerSource: "recall_timeline" } });
  }
  if (!opts.dryRun) {
    const now = new Date();
    await c.calls.updateOne({ _id: callId as never }, { $set: { speakersRelabeledAt: now, recallParticipants: people }, ...(people.length ? { $addToSet: { participants: { $each: people } } } : {}) });
    await c.auditEvents.insertOne({ teamId: String(call?.teamId ?? config.teamId), projectId: String(call?.projectId ?? config.projectId), callId, at: now, type: "speakers_relabeled", actor: config.agentName, reason: `${renamed} of ${lines.length} lines renamed from Recall's speaker timeline`, ref: { people } });
  }
  return { status: "done", total: lines.length, renamed, people };
}

/** Ended calls of the last 30 minutes that still carry heard-as labels: rename them once Recall has the timeline. */
export async function sweepSpeakers(c: Cols): Promise<void> {
  if (!config.recall.apiKey) return;
  const due = await c.calls.find({ teamId: config.teamId, status: "ended", botId: { $type: "string" }, speakersRelabeledAt: { $exists: false }, endedAt: { $gte: new Date(Date.now() - 30 * 60_000) } }).project({ _id: 1 }).limit(3).toArray();
  for (const d of due) {
    const r = await relabelSpeakers(c, String(d._id));
    if (r.status === "done") console.log(`[speakers] ${String(d._id)}: ${r.renamed}/${r.total} lines renamed (${r.people.join(", ") || "nobody"})`);
  }
}
