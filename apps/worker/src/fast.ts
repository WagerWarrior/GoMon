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
import { say } from "./agent.ts";
import { templateFor } from "./templates.ts";

/** Requests that are actions go through the full analysis (commands, policy, outbox), never the fast lane. */
const ACTION = /\b(lock (it|that|this)|create|file|post|correct|forget|send|drop|share|paste|open (a|an|the)|assign|close|merge|remind|schedule|add (a|an|the|to))\b/i;
const NO_ANSWER = "I don't have anything on that yet.";

type MessagesResponse = { content?: { type: string; text?: string }[]; error?: { message: string } };

/** True when this utterance should be answered by the fast lane (decided at ingest, stored as `fastReply`). */
export function wantsFastReply(text: string): boolean {
  const w = parseWake(text);
  return w.addressed && !ACTION.test(w.rest);
}

export async function fastReply(ctx: Ctx, u: { _id: ObjectId; callId: string; seq: number; text: string; speaker: { displayName: string } }): Promise<void> {
  const t0 = Date.now();
  const call = await ctx.c.calls.findOne({ _id: u.callId as never }, { projection: { summary: 1, templateId: 1, memoryEnabled: 1 } });
  const [recent, said, memories, workspace, tpl, knowledge] = await Promise.all([
    ctx.c.utterances.find({ callId: u.callId, seq: { $lt: u.seq } }).sort({ seq: -1 }).limit(8).toArray(),
    ctx.c.says.find({ callId: u.callId, reason: { $ne: "ack" } }).sort({ createdAt: -1 }).limit(4).toArray(),
    call?.memoryEnabled === false ? Promise.resolve([]) : retrieve(ctx.c, ctx, u.text),
    workspaceFor(ctx, u.callId),
    templateFor(ctx.c, ctx.teamId, call?.templateId),
    // Past meeting transcripts, summaries and ADRs by meaning (Atlas Automated Embedding, Voyage).
    call?.memoryEnabled === false ? Promise.resolve([]) : searchKnowledge(ctx.c, ctx, u.text, u.callId),
  ]);
  // Gomon's own lines go into the turn history, so earlier questions read as already answered.
  const turns = [
    ...recent.map((r) => ({ at: r.receivedAt.getTime(), line: `${r.speaker.displayName}: ${r.text}` })),
    ...said.map((s) => ({ at: s.createdAt.getTime(), line: `${config.agentName} (you): ${s.text}` })),
  ].sort((a, b) => a.at - b.at);
  const context = [
    workspace.header,
    typeof call?.summary === "string" && call.summary ? `CALL SO FAR: ${call.summary}` : "",
    "TEAM MEMORY:", ...(memories.length ? memories.map((m) => `- ${m.key ?? "-"} (${m.kind}): ${m.text}`) : ["(none matched)"]),
    "WORKSPACE:", ...workspace.sources.map((s) => `- ${s.id}: ${s.line}`),
    "PAST MEETINGS AND ADRS (semantic search):", ...(knowledge.length ? knowledge.map((k) => `- ${k.line}`) : ["(none)"]),
    "RECENT TURNS (already answered):", ...turns.map((t) => t.line),
  ].filter(Boolean).join("\n");
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
lists or markdown. Questions about you or this call: answer from RECENT TURNS and CALL SO FAR. Anything about the team, design,
customers, past calls, GitHub or the database: use only TEAM MEMORY and WORKSPACE, and name the key, issue number or call once,
naturally. If none of it covers the question, say "${NO_ANSWER}" Speech-to-text may mishear words; read for intent.`,
      messages: [{ role: "user", content: `${context}\n\n${u.speaker.displayName} (to you): ${u.text}` }],
    }),
  });
  const body = (await res.json()) as MessagesResponse;
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? "unknown error"}`);
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
