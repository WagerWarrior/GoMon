/**
 * Speaks outbox results on the live call. A voice request is acknowledged when it is enqueued ("On it, filing that for Max.");
 * this closes the loop once apps/connectors has sent it (or GitHub/policy said no): "Issue 15 is up, assigned to Max." plus the
 * link in the meeting chat. Only actions marked `announce: true` (voice-originated, with a callId) are spoken, each exactly once:
 * `announcedAt` is claimed atomically, so the change stream, the sweep and a second worker never double-speak.
 */
import type { ObjectId } from "mongodb";
import { say } from "./agent.ts";
import type { Ctx } from "./governance.ts";
import { postToMeetingChat } from "./links.ts";
import { loadPeople } from "./people.ts";
import { templateFor } from "./templates.ts";

const DONE = ["sent", "confirmed", "failed", "denied"];
const SWEEP_MS = 5_000;
/** The sweep only looks back this far, so a restart never replays yesterday's results into a new call. */
const LOOKBACK_MS = 30 * 60_000;

/** The payload fields the announcer reads (contract 6 github ops, and the create_issue outbox type). */
type Payload = { op?: string; title?: string; assignees?: string[]; project?: string; state?: string; addAssignees?: string[]; addLabels?: string[]; comment?: string };
type ActionDoc = {
  _id: ObjectId; type: string; callId?: string; status: string; payload?: Payload;
  externalId?: string; externalUrl?: string; note?: string; error?: string; policyCheck?: { reason?: string };
};

/** "create issue: HTTP 422 Validation Failed" -> "Validation Failed"; short enough to say. */
function shortReason(error = ""): string {
  const s = error.replace(/^[\w\s]+: HTTP \d{3}\s*/, "").replace(/^github\s*/i, "").trim();
  return (s.length > 90 ? `${s.slice(0, 87).replace(/\s+\S*$/, "")}…` : s).replace(/[.\s]+$/, "") || "unknown error";
}

function list(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** What to say and what to drop in the chat for one finished action. */
async function describe(ctx: Ctx, a: ActionDoc): Promise<{ text: string; chat?: { label: string; url: string } }> {
  const p = a.payload ?? {};
  const op = a.type === "github" ? String(p.op) : a.type;
  const where = a.type === "post_slack" ? "Slack" : "GitHub";
  if (a.status === "denied") return { text: `I couldn't do that on ${where}: ${a.policyCheck?.reason ?? "not allowed"}.` };
  if (a.status === "failed") return { text: `${where} said no: ${shortReason(a.error)}.` };
  if (a.type === "post_slack") return { text: "Posted to Slack." };

  const n = /#(\d+)(?::|$)/.exec(a.externalId ?? "")?.[1];
  const people = await loadPeople(ctx);
  const who = (logins: unknown) => list(((logins as string[] | undefined) ?? []).map((l) => people.find((x) => x.login.toLowerCase() === l.toLowerCase())?.display.split(" ")[0] ?? l));
  const board = async (id: unknown) => (typeof id === "string" ? (await ctx.c.projects.findOne({ _id: id as never }, { projection: { name: 1 } }))?.name as string | undefined : undefined);
  const url = a.externalUrl;
  const rejected = a.note && /assignee/i.test(a.note) ? " GitHub wouldn't take the assignee, so it's unassigned." : "";
  const noBoard = a.note && /board/i.test(a.note) ? " It didn't make it onto the board." : "";

  if (op === "create_issue") {
    const key = /^([A-Z]-\d{2,3}):/.exec(String(p.title ?? ""))?.[1];
    const assigned = rejected ? "" : who(p.assignees);
    const boardName = !noBoard && p.project ? await board(p.project) : undefined;
    const tail = [assigned && `assigned to ${assigned}`, boardName && `on the ${boardName} board`].filter(Boolean).join(" and ");
    return { text: `Issue ${n} is up${key ? ` for ${key}` : ""}${tail ? `, ${tail}` : ""}.${rejected}${noBoard}`, chat: url ? { label: `#${n} ${p.title ?? ""}`.trim(), url } : undefined };
  }
  if (op === "update_issue") {
    const text = p.state === "closed" ? `Issue ${n} is closed.` : p.state === "open" ? `Issue ${n} is open again.`
      : p.addAssignees?.length && !p.comment && !p.addLabels?.length ? `Issue ${n} is assigned to ${who(p.addAssignees)}.`
      : p.comment && !p.addAssignees?.length && !p.addLabels?.length ? `Comment's on issue ${n}.`
      : `Issue ${n} is updated.`;
    return { text: `${text}${a.note && /assignee/i.test(a.note) ? " GitHub skipped an assignee it didn't recognize." : ""}`, chat: url ? { label: `#${n}`, url } : undefined };
  }
  if (op === "add_to_project") {
    const name = await board(p.project);
    return { text: `Issue ${n} is on the ${name ?? "project"} board.`, chat: url ? { label: `${name ?? "Project"} board`, url } : undefined };
  }
  if (op === "create_project") return { text: `The ${p.title} board is up on GitHub.`, chat: url ? { label: `${p.title} board`, url } : undefined };
  if (op === "create_milestone") return { text: `The ${p.title} milestone is set.`, chat: url ? { label: `Milestone ${p.title}`, url } : undefined };
  return { text: "Done." };
}

/** Claim, then speak and post one finished action. Returns false if it was already announced (or is not announceable). */
async function announce(ctx: Ctx, id: ObjectId): Promise<boolean> {
  const a = (await ctx.c.actions.findOneAndUpdate(
    { _id: id, announce: true, callId: { $type: "string" }, status: { $in: DONE }, announcedAt: { $exists: false } },
    { $set: { announcedAt: new Date() } },
    { returnDocument: "after" },
  )) as ActionDoc | null;
  if (!a?.callId) return false;
  const call = await ctx.c.calls.findOne({ _id: a.callId as never }, { projection: { status: 1, projectId: 1, templateId: 1 } });
  if (!call || call.status === "ended") return false; // nobody to tell; the workspace still shows the result
  const callCtx: Ctx = {
    ...ctx, projectId: typeof call.projectId === "string" ? call.projectId : ctx.projectId,
    voiceId: (await templateFor(ctx.c, ctx.teamId, call.templateId)).voiceId,
  };
  const { text, chat } = await describe(callCtx, a);
  await say(callCtx, a.callId, text, "command");
  if (chat) await postToMeetingChat(callCtx, a.callId, `${chat.label}: ${chat.url}`, { ...chat, source: "action" });
  return true;
}

/**
 * Start announcing outbox results for this team: a change stream on `actions` reacts within a second, and a short sweep catches
 * anything the stream missed (restart, stream error). Returns `stop`.
 */
export function startAnnouncer(ctx: Ctx, log: (m: string) => void = (m) => console.log(`[announce] ${m}`)): { stop: () => Promise<void> } {
  const run = (id: ObjectId) => announce(ctx, id).catch((e) => log(`${id}: ${e?.message ?? e}`));
  const sweep = async () => {
    try {
      const due = await ctx.c.actions.find(
        { teamId: ctx.teamId, announce: true, status: { $in: DONE }, announcedAt: { $exists: false }, createdAt: { $gte: new Date(Date.now() - LOOKBACK_MS) } },
        { projection: { _id: 1 } },
      ).limit(20).toArray();
      for (const d of due) await run(d._id);
    } catch (e) { log(`sweep: ${e instanceof Error ? e.message : e}`); }
  };
  const timer = setInterval(sweep, SWEEP_MS);
  void sweep();
  const stream = ctx.c.actions.watch(
    [{ $match: { operationType: { $in: ["update", "replace"] }, "fullDocument.teamId": ctx.teamId, "fullDocument.announce": true, "fullDocument.status": { $in: DONE } } }],
    { fullDocument: "updateLookup" },
  );
  stream.on("change", (ev) => {
    const doc = "fullDocument" in ev ? ev.fullDocument : undefined;
    if (doc?._id && !doc.announcedAt) void run(doc._id);
  });
  stream.on("error", (e) => log(`change stream error (sweep keeps running): ${e?.message ?? e}`));
  return { stop: async () => { clearInterval(timer); await stream.close().catch(() => {}); } };
}
