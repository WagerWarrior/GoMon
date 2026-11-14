/**
 * Fast reply lane: when someone addresses Gomon with a question (not an action), answer right away from a small plain-text
 * model call, without waiting in the per-call queue behind the full structured analysis. The full analysis still runs for
 * items, conflicts and commands; it skips its own reply for utterances marked `fastReply`.
 * Measured before this lane (live, checkpoint-4): heard -> reply queued 4-10 s. Target: ~2 s, plus TTS.
 */
import type { ObjectId } from "mongodb";
import { config } from "./config.ts";
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
const ACTION = /\b(lock (it|that|this)|create|file|post|correct|forget|send|drop|share|paste|open (a|an|the)|assign|close|merge|remind|schedule|add (a|an|the|to))\b/i;
const NO_ANSWER = "I don't have anything on that yet.";

type MessagesResponse = { content?: { type: string; text?: string }[]; error?: { message: string }; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } };

/** True when this utterance should be answered by the fast lane (decided at ingest, stored as `fastReply`). */
export function wantsFastReply(text: string): boolean {
  const w = parseWake(text);
  return w.addressed && !ACTION.test(w.rest);
}

export async function fastReply(ctx: Ctx, u: { _id: ObjectId; callId: string; seq: number; text: string; speaker: { displayName: string } }): Promise<void> {
  const t0 = Date.now();
  void showCard(ctx.c, u.callId, "thinking");
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
    { title: "", lines: [workspace.header], budget: 150, keep: "head" },
    { title: "CALL SO FAR", lines: typeof call?.summary === "string" && call.summary ? [call.summary] : [], budget: 250, keep: "head" },
    { title: "OPEN CALL ITEMS (said in this call, not locked yet)", lines: open.map((i) => `- [${i.status}] ${i.kind}: ${i.text}`), budget: 300, keep: "head" },
    { title: "TEAM MEMORY", lines: memories.map((m) => `- ${m.key ?? "-"} (${m.kind}): ${m.text}`), budget: 500, keep: "head", empty: "(none matched)" },
    { title: "WORKSPACE", lines: workspace.sources.map((s) => `- ${s.id}: ${s.line}`), budget: 700, keep: "head" },
    { title: "PAST MEETINGS AND ADRS (semantic search)", lines: knowledge.map((k) => `- ${k.line}`), budget: 500, keep: "head", empty: "(none)" },
    { title: "RECENT TURNS (already answered)", lines: turns.map((t) => t.line), budget: 700, keep: "tail" },
  ]);
  const context = win.text;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": config.llmKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: config.analyzeModel,
      max_tokens: 90,
      thinking: { type: "disabled" },
      system: `You are ${config.agentName}, an AI teammate speaking out loud in a live engineering design call. ${tpl.persona}
Answer ONLY what the person just asked, in as few words as it takes (one sentence is usually enough, max 30 words). Never add
other topics, earlier questions or extra facts. Plain words, contractions, no
lists or markdown. Questions about you or this call: answer from RECENT TURNS, OPEN CALL ITEMS and CALL SO FAR. Anything about the
team, design, customers, past calls, GitHub or the database: use only TEAM MEMORY, WORKSPACE and PAST MEETINGS AND ADRS, and name the key, issue number or call once,
naturally. If none of it covers the question, say "${NO_ANSWER}" Speech-to-text may mishear words; read for intent.`,
      messages: [{ role: "user", content: `${context}\n\n${u.speaker.displayName} (to you): ${u.text}` }],
    }),
  });
  const body = (await res.json()) as MessagesResponse;
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? "unknown error"}`);
  // The meter: what was in the window for this answer, section by section, next to the API's real token counts.
  void ctx.c.agentEvents.insertOne({
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
  // Grounding: every memory key said out loud must be a real active memory.
  const keys = [...new Set([...text.matchAll(/\b([A-Z])-(\d{2,3})\b/g)].map((m) => m[0]))];
  if (keys.length) {
    const active = await ctx.c.memories.countDocuments({ teamId: ctx.teamId, status: "active", key: { $in: keys } });
    if (active < keys.length) {
      await ctx.c.agentEvents.insertOne({ callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, at: new Date(), utteranceId: u._id, kind: "ungrounded_reply_dropped", reply: text, cited: keys });
      text = NO_ANSWER;
    }
  }
  await say({ ...ctx, voiceId: tpl.voiceId }, u.callId, text, "addressed", "high", u._id);
  await ctx.c.timings.insertOne({ callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, stage: "fast_reply", ms: Date.now() - t0, at: new Date(), utteranceId: u._id });
}
