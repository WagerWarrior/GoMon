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

export type RosterEvent = { kind: "join" | "leave"; id: string; name: string; botId: string | null };

const isAgent = (name: string) => name.trim().toLowerCase() === config.agentName.toLowerCase();

/** A Recall participant event as who, which way and from which bot; anything else (or Gomon itself) is null. Pure. */
export function parseParticipantEvent(body: unknown): RosterEvent | null {
  const b = body as { event?: unknown; data?: { data?: { participant?: { id?: unknown; name?: unknown } }; bot?: { id?: unknown } } } | null;
  const kind = b?.event === "participant_events.join" ? "join" : b?.event === "participant_events.leave" ? "leave" : null;
  const p = b?.data?.data?.participant;
  if (!kind || !p || (typeof p.id !== "number" && typeof p.id !== "string")) return null;
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name || isAgent(name)) return null;
  return { kind, id: String(p.id), name, botId: typeof b?.data?.bot?.id === "string" ? b.data.bot.id : null };
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
      { _id: callId as never, "liveParticipants.id": { $ne: e.id } },
      { $push: { liveParticipants: { id: e.id, name: e.name, joinedAt: new Date() } }, $addToSet: { participants: e.name } } as never,
    );
  } else {
    await c.calls.updateOne({ _id: callId as never }, { $pull: { liveParticipants: { id: e.id } } } as never);
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
      const e = parseParticipantEvent(JSON.parse(await readBody(req)));
      if (e) {
        await applyRosterEvent(c, callId, e);
        console.log(`[roster] ${callId}: ${e.name} ${e.kind === "join" ? "joined" : "left"}`);
        if (e.kind === "join") scheduleRollCall(c, callId);
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
