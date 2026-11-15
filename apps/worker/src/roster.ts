/**
 * Who is in the Google Meet right now. Recall sends participant_events.join / .leave to a public URL (a Cloudflare quick
 * tunnel on the Mac, `npm run tunnel`), which reaches only the small events server below, never the worker's API: the local
 * listener page trusts loopback, and tunnel traffic arrives from loopback. The call keeps `liveParticipants` (who is in
 * it now) and `participants` (everyone who was); a few seconds after the first joins, Gomon posts a roll call in the chat.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Cols } from "./db.ts";
import { config } from "./config.ts";
import { postToMeetingChat } from "./links.ts";
import type { Ctx } from "./governance.ts";
import { loadPeople, resolvePerson, type Person } from "./people.ts";
import { speakerFor, type Span } from "./speakers.ts";

export type RosterEvent = { kind: "join" | "leave" | "speech_on" | "speech_off"; id: string; name: string; botId: string | null; at: number };
const KINDS: Record<string, RosterEvent["kind"]> = {
  "participant_events.join": "join", "participant_events.leave": "leave",
  "participant_events.speech_on": "speech_on", "participant_events.speech_off": "speech_off",
};

const isAgent = (name: string) => name.trim().toLowerCase() === config.agentName.toLowerCase();

/**
 * A Recall participant event (join, leave, speech on/off) as who, what, from which bot and when (Recall's absolute time,
 * else now); anything else, or Gomon itself, is null. Pure apart from the clock fallback.
 */
export function parseParticipantEvent(body: unknown, now = Date.now()): RosterEvent | null {
  const b = body as { event?: unknown; data?: { data?: { participant?: { id?: unknown; name?: unknown }; timestamp?: { absolute?: unknown } }; bot?: { id?: unknown } } } | null;
  const kind = typeof b?.event === "string" ? KINDS[b.event] : undefined;
  const p = b?.data?.data?.participant;
  if (!kind || !p || (typeof p.id !== "number" && typeof p.id !== "string")) return null;
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name || isAgent(name)) return null;
  const abs = b?.data?.data?.timestamp?.absolute;
  const at = typeof abs === "string" && Number.isFinite(Date.parse(abs)) ? Date.parse(abs) : now;
  return { kind, id: String(p.id), name, botId: typeof b?.data?.bot?.id === "string" ? b.data.bot.id : null, at };
}

/** The team member a Meet display name names ("Robert" -> "Robert Reder"); a stranger keeps the name Meet shows. Pure. */
export function meetName(name: string, people: Person[]): string {
  return resolvePerson(people, name, "")?.display ?? name;
}

/**
 * Who talked when in one call, from speech_on/off: closed spans plus whoever is talking now (open until now). Kept for
 * `keepMs` (two minutes by default): enough for any transcript line, and nothing grows.
 */
export class SpeechTimeline {
  private open = new Map<string, { name: string; start: number }>();
  private closed: Span[] = [];
  constructor(private keepMs = 120_000) {}
  on(id: string, name: string, at: number): void { if (!this.open.has(id)) this.open.set(id, { name, start: at }); }
  off(id: string, at: number): void {
    const o = this.open.get(id);
    if (!o) return;
    this.open.delete(id);
    this.closed.push({ name: o.name, start: o.start, end: Math.max(at, o.start) });
  }
  spans(now: number): Span[] {
    this.closed = this.closed.filter((s) => s.end >= now - this.keepMs);
    return [...this.closed, ...[...this.open.values()].map((o) => ({ name: o.name, start: o.start, end: now }))];
  }
  get empty(): boolean { return !this.open.size && !this.closed.length; }
}

const timelines = new Map<string, SpeechTimeline>();
/**
 * Who was talking while a transcript line was said, by Meet's speech events; null when this call has none (no events tunnel,
 * or the speaker is muted in Meet) or nobody clearly held the floor. `endedAt`: when the line was committed (ms epoch).
 */
export function liveSpeaker(callId: string, endedAt: number, words: number): string | null {
  const t = timelines.get(callId);
  if (!t || t.empty) return null;
  return speakerFor(t.spans(endedAt), endedAt, words);
}

/** The transcript label: the live speaker when Meet says who it was, keeping what the listener heard it as. Pure. */
export function labelLine(heard: string, live: string | null): { displayName: string; heardAs?: string } {
  return live && live !== heard ? { displayName: live, heardAs: heard } : { displayName: heard };
}

/** Team people, per team, for a minute: matching Meet names must not cost a database read per event. */
let peopleCache: { at: number; teamId: string; people: Person[] } | null = null;
async function teamPeople(c: Cols, teamId: string): Promise<Person[]> {
  if (peopleCache && peopleCache.teamId === teamId && Date.now() - peopleCache.at < 60_000) return peopleCache.people;
  const people = await loadPeople({ c, teamId }).catch(() => [] as Person[]);
  peopleCache = { at: Date.now(), teamId, people };
  return people;
}

/** The chat line naming everyone in the call, once each, in join order. Pure. */
export function rollCall(names: string[]): string {
  const n = [...new Set(names.map((x) => x.trim()).filter(Boolean))];
  if (!n.length) return `${config.agentName} here. Nobody else is in this call yet.`;
  const list = n.length === 1 ? n[0] : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
  return `${config.agentName} here. In this call: ${list}.`;
}

/** Recall cannot send a bearer token; the webhook token rides in the URL. No token configured: nothing is accepted. Pure. */
export function eventsAuthorized(given: string | null, expected: string): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Apply one event to the call (atomic: a repeated join or a leave of someone unknown changes nothing). */
export async function applyRosterEvent(c: Cols, callId: string, e: RosterEvent): Promise<void> {
  if (e.kind === "join") {
    await c.calls.updateOne(
      // Once per person: a re-sent bot sees everyone again under new ids, and one person on two devices is one name.
      { _id: callId as never, liveParticipants: { $not: { $elemMatch: { $or: [{ id: e.id }, { name: e.name }] } } } },
      { $push: { liveParticipants: { id: e.id, name: e.name, joinedAt: new Date() } }, $addToSet: { participants: e.name } } as never,
    );
  } else {
    await c.calls.updateOne({ _id: callId as never }, { $pull: { liveParticipants: { $or: [{ id: e.id }, { name: e.name }] } } } as never);
  }
}

/** Who is in the call now, by name, in join order. */
export async function inCallNow(c: Cols, callId: string): Promise<string[]> {
  const call = await c.calls.findOne({ _id: callId as never }, { projection: { liveParticipants: 1 } });
  return ((call?.liveParticipants as { name: string }[] | undefined) ?? []).map((p) => p.name);
}

// Joins arrive in a burst when the bot enters (everyone already there): the roll call waits until they stop.
const ROLL_CALL_QUIET_MS = 4000;
const pending = new Map<string, NodeJS.Timeout>();
function scheduleRollCall(c: Cols, callId: string): void {
  clearTimeout(pending.get(callId));
  pending.set(callId, setTimeout(() => {
    pending.delete(callId);
    void (async () => {
      // Once per call: the first caller to set rollCallAt posts it.
      const claimed = await c.calls.findOneAndUpdate({ _id: callId as never, rollCallAt: { $exists: false } }, { $set: { rollCallAt: new Date() } }, { projection: { teamId: 1, projectId: 1 } });
      if (!claimed) return;
      const ctx = { c, teamId: String(claimed.teamId ?? config.teamId), projectId: String(claimed.projectId ?? config.projectId) } as Ctx;
      await postToMeetingChat(ctx, callId, rollCall(await inCallNow(c, callId)));
    })().catch((e) => console.error("[roster] roll call:", e instanceof Error ? e.message : e));
  }, ROLL_CALL_QUIET_MS));
}

const readBody = (req: IncomingMessage, limit = 64 * 1024) => new Promise<string>((resolve, reject) => {
  let s = "";
  req.on("data", (d: Buffer) => { s += d; if (s.length > limit) { reject(new Error("too large")); req.destroy(); } });
  req.on("end", () => resolve(s)); req.on("error", reject);
});

/** The only thing the tunnel reaches: POST /recall/events/?callId=…&token=… . Always 200 to Recall once authorized. */
export function startEventsServer(c: Cols, port = Number(process.env.EVENTS_PORT || 3011)): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const end = (code: number) => void res.writeHead(code, { "content-type": "application/json" }).end(code === 200 ? '{"ok":true}' : '{"ok":false}');
    if (req.method !== "POST" || !/^\/recall\/events\/?$/.test(url.pathname)) return end(404);
    if (!eventsAuthorized(url.searchParams.get("token"), config.recall.webhookToken)) return end(401);
    const callId = url.searchParams.get("callId");
    if (!callId) return end(400);
    try {
      const raw = parseParticipantEvent(JSON.parse(await readBody(req)));
      if (raw) {
        const e = { ...raw, name: meetName(raw.name, await teamPeople(c, config.teamId)) };
        if (e.kind === "speech_on" || e.kind === "speech_off") {
          const t = timelines.get(callId) ?? new SpeechTimeline();
          timelines.set(callId, t);
          if (e.kind === "speech_on") t.on(e.id, e.name, e.at); else t.off(e.id, e.at);
        } else {
          await applyRosterEvent(c, callId, e);
          console.log(`[roster] ${callId}: ${e.name}${e.name !== raw.name ? ` (in Meet as "${raw.name}")` : ""} ${e.kind === "join" ? "joined" : "left"}`);
          if (e.kind === "join") scheduleRollCall(c, callId);
        }
      }
      end(200);
    } catch (err) {
      console.error("[roster]", err instanceof Error ? err.message : err);
      end(400);
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`[roster] Recall events on http://127.0.0.1:${port}/recall/events/ (tunnel: npm run tunnel)`));
  return server;
}
