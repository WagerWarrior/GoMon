/**
 * Rolling call summary on `calls.summary`, so the model sees the whole call and not only the last RECENT_TURNS lines.
 * Refreshed off the critical path every SUMMARY_EVERY utterances: previous summary + new turns -> new summary (one small call).
 */
import { config, modelTuning } from "./config.ts";
import type { Ctx } from "./governance.ts";

const SUMMARY_EVERY = 12;
const MAX_NEW_TURNS = 80;

type MessagesResponse = { content?: { type: string; text?: string }[]; error?: { message: string } };
type CallSummaryDoc = { summary?: string; summarySeq?: number };

/** Fire-and-forget after a batch: refresh when SUMMARY_EVERY new utterances arrived since the last summary. */
export async function maybeRefreshSummary(ctx: Ctx, callId: string, latestSeq: number): Promise<void> {
  if (latestSeq < SUMMARY_EVERY) return; // RECENT_TURNS already covers a short call
  // Atomic claim: only one refresh per call at a time, across workers.
  const claimed = await ctx.c.calls.findOneAndUpdate(
    { _id: callId as never, summarizing: { $ne: true }, $or: [{ summarySeq: { $exists: false } }, { summarySeq: { $lte: latestSeq - SUMMARY_EVERY } }] },
    { $set: { summarizing: true } },
    { projection: { summary: 1, summarySeq: 1 } },
  );
  if (!claimed) return;
  const prev = claimed as CallSummaryDoc;
  try {
    const turns = await ctx.c.utterances.find({ callId, seq: { $gt: prev.summarySeq ?? 0, $lte: latestSeq } }).sort({ seq: 1 }).limit(MAX_NEW_TURNS).toArray();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": config.llmKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: config.analyzeModel,
        max_tokens: 400,
        ...modelTuning(), // thinking off (Haiku) or medium effort: left alone it can spend the whole budget before writing
        system: "You maintain a running summary of a live engineering design call for an AI participant. Transcripts are raw " +
          "speech-to-text. Write at most 120 words, plain text: topics covered in order, proposals and who made them, agreements, " +
          "open questions, and anything asked of the AI. Keep names and numbers exact. Drop small talk and setup chatter.",
        messages: [{
          role: "user",
          content: `PREVIOUS SUMMARY:\n${prev.summary || "(start of call)"}\n\nNEW TURNS:\n${turns.map((t) => `${t.speaker.displayName}: ${t.text}`).join("\n")}\n\nUpdated summary:`,
        }],
      }),
    });
    const body = (await res.json()) as MessagesResponse;
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? "unknown error"}`);
    const text = body.content?.find((b) => b.type === "text")?.text?.trim();
    if (text) await ctx.c.calls.updateOne({ _id: callId as never }, { $set: { summary: text, summarySeq: latestSeq, summaryAt: new Date() } });
  } finally {
    await ctx.c.calls.updateOne({ _id: callId as never }, { $unset: { summarizing: "" } });
  }
}
