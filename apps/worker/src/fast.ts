/**
 * Fast reply lane: when someone addresses Gomon with a question (not an action), answer right away from a small plain-text
 * model call, without waiting in the per-call queue behind the full structured analysis. The full analysis still runs for
 * items, conflicts and commands; it skips its own reply for utterances marked `fastReply`.
 * Measured before this lane (live, checkpoint-4): heard -> reply queued 4-10 s. Target: ~2 s, plus TTS.
 */
import type { ObjectId } from "mongodb";
import { config, modelTuning } from "./config.ts";
import type { Ctx } from "./governance.ts";
import { retrieve } from "./retrieve.ts";
import { workspaceFor } from "./context.ts";
import { searchKnowledge } from "./knowledge.ts";
import { parseWake } from "./wake.ts";
import { showCard } from "./card.ts";
import { say } from "./agent.ts";
import { templateFor } from "./templates.ts";
import { buildWindow } from "./window.ts";

/** Requests that are actions go through the full analysis (commands, policy, outbox), never the fast lane. */
// "attach D-15 to an issue", "turn D-09 into an issue", "make a ticket", "divert a task to Rob": live (Nov 14) these got a spoken
// "I'd want to confirm" from this lane while the action lane filed the issue.
const ACTION = /\b(lock (it|that|this)|create|file|post|correct|forget|send|drop|share|paste|open (a|an|the)|assign|close|merge|remind|schedule|add (a|an|the|to)|attach|turn\b.{0,40}\binto|make (a|an|it)|divert|link\b.{0,40}\bto)\b/i;
const NO_ANSWER = "I don't have anything on that yet.";

type MessagesResponse = { content?: { type: string; text?: string }[]; error?: { message: string }; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } };

/** True when this utterance should be answered by the fast lane (decided at ingest, stored as `fastReply`). */
export function wantsFastReply(text: string): boolean {
  const w = parseWake(text);
  return w.addressed && !ACTION.test(w.rest);
}

/** `dry`: build the same answer and return it without speaking or writing anything (npm run ask). */
export async function fastReply(ctx: Ctx, u: { _id: ObjectId; callId: string; seq: number; text: string; speaker: { displayName: string } }, dry = false): Promise<string> {
  const t0 = Date.now();
  if (!dry) void showCard(ctx.c, u.callId, "thinking");
  // Everything is fetched at once. The call document used to be read first (one Atlas round trip, ~100 ms, before any search
  // started); memory is on for nearly every call, so the searches start now and are dropped if this call has it off.
  const callP = ctx.c.calls.findOne({ _id: u.callId as never }, { projection: { summary: 1, templateId: 1, memoryEnabled: 1 } });
  const [call, recent, said, open, found, workspace, tpl, foundKnowledge] = await Promise.all([
    callP,
    // The window's budgets (below) decide how much of this is kept, so more is read than the old fixed 8 turns / 4 lines.
    ctx.c.utterances.find({ callId: u.callId, seq: { $lt: u.seq } }).sort({ seq: -1 }).limit(16).toArray(),
    ctx.c.says.find({ callId: u.callId, reason: { $ne: "ack" }, status: { $ne: "cancelled" } }).sort({ createdAt: -1 }).limit(6).toArray(),
    // What this call has proposed or is locking: without it "what did we just propose?" had no answer on the fast lane.
    ctx.c.callItems.find({ callId: u.callId, status: { $in: ["proposed", "locking"] } }).sort({ createdAt: -1 }).limit(12).toArray(),
    retrieve(ctx.c, ctx, u.text),
    workspaceFor(ctx, u.callId),
    callP.then((cl) => templateFor(ctx.c, ctx.teamId, cl?.templateId)),
    // Past meeting transcripts, summaries and ADRs by meaning (Atlas Automated Embedding, Voyage).
    searchKnowledge(ctx.c, ctx, u.text, u.callId),
  ]);
  const memoryOn = call?.memoryEnabled !== false;
  const memories = memoryOn ? found : [];
  const knowledge = memoryOn ? foundKnowledge : [];
  // Gomon's own lines go into the turn history, so earlier questions read as already answered.
  const turns = [
    ...recent.map((r) => ({ at: r.receivedAt.getTime(), line: `${r.speaker.displayName}: ${r.text}` })),
    ...said.map((s) => ({ at: s.createdAt.getTime(), line: `${config.agentName} (you): ${s.text}` })),
  ].sort((a, b) => a.at - b.at);
  // One budgeted window (window.ts): fixed order, a token budget per section, and a record of what went in and what was cut.
  const win = buildWindow([
    { title: "", lines: [workspace.header], budget: 900, keep: "head" },
    { title: "CALL SO FAR", lines: typeof call?.summary === "string" && call.summary ? [call.summary] : [], budget: 250, keep: "head" },
    { title: "OPEN CALL ITEMS (said in this call, not locked yet)", lines: open.map((i) => `- [${i.status}] ${i.kind}: ${i.text}`), budget: 300, keep: "head" },
    { title: "TEAM MEMORY", lines: memories.map((m) => `- ${m.key ?? "-"} (${m.kind}): ${m.text}`), budget: 500, keep: "head", empty: "(none matched)" },
    { title: "TEAM RECORDS (filed tickets, memory index of every project, GitHub issues, past calls)", lines: workspace.sources.map((s) => `- ${s.line}`), budget: 3200, keep: "head" },
    { title: "PAST MEETINGS AND ADRS (semantic search)", lines: knowledge.map((k) => `- ${k.line}`), budget: 500, keep: "head", empty: "(none)" },
    { title: "RECENT TURNS (already answered)", lines: turns.map((t) => t.line), budget: 700, keep: "tail" },
  ]);
  const context = win.text;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": config.llmKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: config.analyzeModel,
      max_tokens: 120,
      ...modelTuning(),
      system: `You are ${config.agentName}, an AI teammate speaking out loud in a live engineering design call. ${tpl.persona}
Answer ONLY what the person just asked, in as few words as it takes (one sentence is usually enough, max 35 words). Never add
other topics, earlier questions or extra facts. Plain spoken words, contractions, no lists or markdown.
Where things are: the call, its people and the team are at the top (WHERE YOU ARE, THIS CALL, PEOPLE, TEAM). Every locked
memory of every project is in TEAM RECORDS ("memory D-15 …"), with the tickets you filed ("filed ticket …") and GitHub issues;
TEAM MEMORY has the best matches for this question; PAST MEETINGS AND ADRS, CALL SO FAR, OPEN CALL ITEMS and RECENT TURNS cover
meetings. Name the key, issue number or meeting once, naturally. A key someone names ("D17", "ticket D 15") is a memory key: if
it is not in TEAM RECORDS, say it doesn't exist yet and name the latest key of that kind. Never say "workspace" or "context".
Only when nothing here covers the question, say exactly "${NO_ANSWER}" Speech-to-text may mishear words; read for intent.`,
      messages: [{ role: "user", content: `${context}\n\n${u.speaker.displayName} (to you): ${u.text}` }],
    }),
  });
  const body = (await res.json()) as MessagesResponse;
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? "unknown error"}`);
  // The meter: what was in the window for this answer, section by section, next to the API's real token counts.
  if (!dry) void ctx.c.agentEvents.insertOne({
    callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, at: new Date(), utteranceId: u._id, kind: "context_window", lane: "fast",
    sections: win.use, estimatedTokens: win.tokens, droppedLines: win.dropped,
    inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null, model: config.analyzeModel,
  }).catch((e) => console.error("[window]", e instanceof Error ? e.message : e));
  let text = body.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
  // Spoken answers stay short: first two sentences, at most ~35 words (long clips also take longer to synthesize).
  text = (text.match(/[^.!?]+[.!?]+/g) ?? [text]).slice(0, 2).join(" ").trim();
  const words = text.split(/\s+/);
  if (words.length > 35) text = `${words.slice(0, 35).join(" ").replace(/[,;:]$/, "")}.`;
  if (!text) text = NO_ANSWER;
  // Grounding: every memory key said out loud must be a real active memory, except a key the asker named themself
  // ("there's no D-17 yet" is the right answer to "what about D17?").
  const asked = new Set([...u.text.matchAll(/\b([a-z])[\s-]?(\d{1,3})\b/gi)].map((m) => `${m[1].toUpperCase()}-${m[2].padStart(2, "0")}`));
  const keys = [...new Set([...text.matchAll(/\b([A-Z])-(\d{2,3})\b/g)].map((m) => m[0]))].filter((k) => !asked.has(k));
  if (keys.length) {
    const active = await ctx.c.memories.countDocuments({ teamId: ctx.teamId, status: "active", key: { $in: keys } });
    if (active < keys.length) {
      if (dry) console.error(`[ask] ungrounded, dropped: ${text} (cited ${keys.join(", ")})`);
      else await ctx.c.agentEvents.insertOne({ callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, at: new Date(), utteranceId: u._id, kind: "ungrounded_reply_dropped", reply: text, cited: keys });
      text = NO_ANSWER;
    }
  }
  if (dry) return text;
  await say({ ...ctx, voiceId: tpl.voiceId }, u.callId, text, "addressed", "high", u._id);
  await ctx.c.timings.insertOne({ callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, stage: "fast_reply", ms: Date.now() - t0, at: new Date(), utteranceId: u._id });
  return text;
}
