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
import { agentProfile } from "./profile.ts";
import { firstSentence, issueLinks, restAfter, spokenLine } from "./speech.ts";
import { readStream, type StreamUsage } from "./stream.ts";
import { prerender } from "./voice.ts";
import { postToMeetingChat } from "./links.ts";
import { chatTraceOn, traceLine } from "./trace.ts";

/** A step with its own clock, for the answer trace. */
const timed = <T>(p: Promise<T>) => { const s = Date.now(); return p.then((v) => ({ v, ms: Date.now() - s })); };

/** Requests that are actions go through the full analysis (commands, policy, outbox), never the fast lane. */
// "attach D-15 to an issue", "turn D-09 into an issue", "make a ticket", "divert a task to Rob": live (Nov 14) these got a spoken
// "I'd want to confirm" from this lane while the action lane filed the issue.
const ACTION = /\b(lock (it|that|this)|create|file|post|correct|forget|send|drop|share|paste|open (a|an|the)|assign|close|merge|remind|schedule|add (a|an|the|to)|attach|turn\b.{0,40}\binto|make (a|an|it)|divert|link|url)\b/i;
const NO_ANSWER = "I don't have anything on that yet.";

type MessagesResponse = { error?: { message: string } };

/** True when this utterance should be answered by the fast lane (decided at ingest, stored as `fastReply`). */
export function wantsFastReply(text: string): boolean {
  const w = parseWake(text);
  // The whole sentence is checked, not only what follows the name: "can you assign it to Max, please? Hey, Gomon." (live,
  // Nov 14) had nothing after the name, got "there's nothing to assign" from this lane, and two seconds later the action
  // lane filed and assigned the issue.
  return w.addressed && !ACTION.test(text);
}

const SLOW_MS = 4500;
const state = (ctx: Ctx, callId: string, detail: string) =>
  void ctx.c.calls.updateOne({ _id: callId as never }, { $set: { agentState: { state: "searching", detail, at: new Date() } } }).catch(() => {});

type Asked = { _id: ObjectId; callId: string; seq: number; text: string; speaker: { displayName: string } };

/**
 * Answers a question to Gomon. While it works, the call's state line (shown on the camera card and the dashboard) says what it
 * is doing; past SLOW_MS it says so out loud once; and if the answer fails it says that too instead of going silent.
 * `dry`: build the same answer and return it without speaking or writing anything (npm run ask).
 */
export async function fastReply(ctx: Ctx, u: Asked, dry = false): Promise<string> {
  if (dry) return answer(ctx, u, true);
  void showCard(ctx.c, u.callId, "thinking");
  state(ctx, u.callId, "searching memory, tickets and past meetings");
  const slow = setTimeout(() => void say(ctx, u.callId, "Still working on that, one moment.", "ack", "normal", u._id).catch(() => {}), SLOW_MS);
  try {
    // The "still working" line is dropped the moment the first sentence is spoken.
    return await answer(ctx, u, false, () => clearTimeout(slow));
  } catch (e) {
    await say(ctx, u.callId, "Sorry, I couldn't finish that answer. Ask me again.", "addressed", "high", u._id).catch(() => {});
    throw e;
  } finally {
    clearTimeout(slow);
  }
}

async function answer(ctx: Ctx, u: Asked, dry: boolean, onSpeaking: () => void = () => {}): Promise<string> {
  const t0 = Date.now();
  // Everything is fetched at once. The call document used to be read first (one Atlas round trip, ~100 ms, before any search
  // started); memory is on for nearly every call, so the searches start now and are dropped if this call has it off.
  const callP = ctx.c.calls.findOne({ _id: u.callId as never }, { projection: { summary: 1, templateId: 1, memoryEnabled: 1 } });
  const [call, recent, said, open, foundT, workspace, tpl, knowledgeT] = await Promise.all([
    callP,
    // The window's budgets (below) decide how much of this is kept, so more is read than the old fixed 8 turns / 4 lines.
    ctx.c.utterances.find({ callId: u.callId, seq: { $lt: u.seq } }).sort({ seq: -1 }).limit(16).toArray(),
    // Cut-off answers stay in the history (marked): without them the question they answered looked unanswered, and the next
    // answer went to it instead of the new question (seen Nov 14: "what's the weather" got the D-09 answer again).
    ctx.c.says.find({ callId: u.callId, reason: { $ne: "ack" } }).sort({ createdAt: -1 }).limit(6).toArray(),
    // What this call has proposed or is locking: without it "what did we just propose?" had no answer on the fast lane.
    ctx.c.callItems.find({ callId: u.callId, status: { $in: ["proposed", "locking"] } }).sort({ createdAt: -1 }).limit(12).toArray(),
    timed(retrieve(ctx.c, ctx, u.text)),
    workspaceFor(ctx, u.callId),
    callP.then((cl) => templateFor(ctx.c, ctx.teamId, cl?.templateId)),
    // Past meeting transcripts, summaries and ADRs by meaning (Atlas Automated Embedding, Voyage).
    timed(searchKnowledge(ctx.c, ctx, u.text, u.callId)),
  ]);
  const found = foundT.v, foundKnowledge = knowledgeT.v;
  const memoryOn = call?.memoryEnabled !== false;
  const memories = memoryOn ? found : [];
  const knowledge = memoryOn ? foundKnowledge : [];
  // Gomon's own lines go into the turn history, so earlier questions read as already answered.
  const turns = [
    ...recent.map((r) => ({ at: r.receivedAt.getTime(), line: `${r.speaker.displayName}: ${r.text}` })),
    ...said.map((s) => ({ at: s.createdAt.getTime(), line: `${config.agentName} (you${s.status === "cancelled" ? ", answered, then interrupted" : ""}): ${s.text}` })),
  ].sort((a, b) => a.at - b.at);
  // One budgeted window (window.ts): fixed order, a token budget per section, and a record of what went in and what was cut.
  const win = buildWindow([
    { title: "", lines: [workspace.header], budget: 900, keep: "head" },
    { title: "CALL SO FAR", lines: typeof call?.summary === "string" && call.summary ? [call.summary] : [], budget: 250, keep: "head" },
    { title: "OPEN CALL ITEMS (said in this call, not locked yet)", lines: open.map((i) => `- [${i.status}] ${i.kind}: ${i.text}`), budget: 300, keep: "head" },
    { title: "TEAM MEMORY", lines: memories.map((m) => `- ${m.key ?? "-"} (${m.kind}): ${m.text}`), budget: 500, keep: "head", empty: "(none matched)" },
    { title: "PAST MEETINGS AND ADRS (semantic search)", lines: knowledge.map((k) => `- ${k.line}`), budget: 500, keep: "head", empty: "(none)" },
    { title: "RECENT TURNS (already answered)", lines: turns.map((t) => t.line), budget: 700, keep: "tail" },
  ]);
  // The team records are the same from one question to the next, so they go first as their own block and the model API
  // keeps them cached (with the instruction set) for five minutes: later questions start writing sooner.
  const records = buildWindow([
    { title: "TEAM RECORDS (filed tickets, memory index of every project, GitHub issues, past calls)", lines: workspace.sources.map((s) => `- ${s.line}`), budget: 3600, keep: "head" },
  ]);
  const voiceCtx = { ...ctx, voiceId: tpl.voiceId };
  // Grounding: every memory key said out loud must be a real active memory, except a key the asker named themself
  // ("there's no D-17 yet" is the right answer to "what about D17?"). Returns the keys that are not real.
  const asked = new Set([...u.text.matchAll(/\b([a-z])[\s-]?(\d{1,3})\b/gi)].map((m) => `${m[1].toUpperCase()}-${m[2].padStart(2, "0")}`));
  const ungrounded = async (line: string): Promise<string[]> => {
    const keys = [...new Set([...line.matchAll(/\b([A-Z])-(\d{2,3})\b/g)].map((m) => m[0]))].filter((k) => !asked.has(k));
    if (!keys.length) return [];
    const active = await ctx.c.memories.countDocuments({ teamId: ctx.teamId, status: "active", key: { $in: keys } });
    return active < keys.length ? keys : [];
  };
  const dropped = async (line: string, keys: string[]) => {
    if (dry) console.error(`[ask] ungrounded, dropped: ${line} (cited ${keys.join(", ")})`);
    else await ctx.c.agentEvents.insertOne({ callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, at: new Date(), utteranceId: u._id, kind: "ungrounded_reply_dropped", reply: line, cited: keys });
  };
  if (!dry) state(ctx, u.callId, "writing the answer");
  const tModel = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": config.llmKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    signal: AbortSignal.timeout(12_000),
    body: JSON.stringify({
      model: config.analyzeModel,
      max_tokens: 200,
      stream: true,
      ...modelTuning(),
      system: `${agentProfile(config.agentName)}

THIS TURN: someone just said your name and asked you something. Reply with what you will say out loud, nothing else.
${tpl.persona}
- Answer what was asked, in one or two short sentences (max 35 words). Anything longer is cut off, so never open with a
  count or a list you cannot finish in that space. No earlier questions. If the second sentence is free, use it for the one
  active-assistance note from your profile; otherwise leave it out.
- Say a person's name, never a GitHub login (TEAM gives the name for each login). Say "issue 25", not "#25".
- Where things are: the call, its people and the team are at the top (WHERE YOU ARE, THIS CALL, PEOPLE, TEAM). Every locked
  memory of every project is in TEAM RECORDS ("memory D-15 …") with the tickets you filed ("filed ticket …") and the GitHub
  issues ("issue #…"). TEAM MEMORY has the best matches for this question.
- "Tickets" and "issues" mean the team's GitHub issues, whenever they were filed, not only on this call. "issue #25 [open]
  filed by you from memory D-09" is a ticket you filed; [open] ones are the outstanding ones. Count and name them from TEAM RECORDS.
- A key someone names is a memory key: if it is not in TEAM RECORDS, say it doesn't exist yet and name the latest key of that kind.
- When you name a GitHub issue by number, its link is posted in the Meet chat for you: say "it's in the chat", never the link.
- The question may come before or after your name, and speech-to-text may mishear words: read RECENT TURNS for intent.
- The question is the LAST line, under "ANSWER THIS NOW". Everything in RECENT TURNS is over: never answer one of those again.
- A question about something outside the team and this call (weather, news, general knowledge), or one nothing in front of
  you covers: say exactly "${NO_ANSWER}" and nothing else.`,
      messages: [{ role: "user", content: [
        { type: "text", text: records.text, cache_control: { type: "ephemeral" } },
        { type: "text", text: `${win.text}\n\nANSWER THIS NOW (only this):\n${u.speaker.displayName} (to you): ${u.text}` },
      ] }],
    }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as MessagesResponse;
    throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? "unknown error"}`);
  }
  // Streamed (Max, Nov 14). Measured the same day on Sonnet 5.5: an answer this short does not arrive word by word. One
  // character comes at the first token (0.5-0.9 s), then the whole text in one burst about 0.65 s later, so the first sentence
  // is known only ~10 ms before the end. Speaking it early would gain nothing and put a pause between two clips, so it is off
  // unless SPEAK_FIRST_SENTENCE=on (worth it only if answers get longer). What does help is the cached records block:
  // 4,770 of 4,856 input tokens were read from the cache on the second question, and the answer came 0.2-0.3 s sooner.
  let raw = "";
  let firstMs: number | null = null;
  let early: Promise<string | null> | null = null;
  const speakEarly = async (first: string): Promise<string | null> => {
    if (first === NO_ANSWER) return null;
    if (!dry) prerender(first, tpl.voiceId); // the voice renders while the keys are checked
    if ((await ungrounded(first)).length) return null; // held back: the whole answer is checked and dropped below
    firstMs = Date.now() - t0;
    if (!dry) {
      onSpeaking();
      await say(voiceCtx, u.callId, first, "addressed", "high", u._id);
    }
    return first;
  };
  let stream: { stopReason?: string; usage: StreamUsage } = { usage: {} };
  try {
    stream = await readStream(res.body as unknown as AsyncIterable<Uint8Array>, (delta) => {
      raw += delta;
      if (early || process.env.SPEAK_FIRST_SENTENCE !== "on") return;
      const first = firstSentence(raw);
      if (first) early = speakEarly(first).catch((e) => (console.error("[fast] first sentence:", e instanceof Error ? e.message : e), null));
    });
  } catch (e) {
    // The stream broke after the first sentence was already spoken: finish with what arrived, do not apologise over it.
    if (!(early && (await early))) throw e;
    stream.stopReason = "max_tokens";
  }
  const modelMs = Date.now() - tModel;
  const spoken = early ? await early : null;
  if (dry && process.env.ASK_RAW) console.error(`[ask] raw (${stream.stopReason}, ${stream.usage.output_tokens} tokens): ${JSON.stringify(raw)}`);
  // The meter: what was in the window for this answer, section by section, next to the API's real token counts.
  if (!dry) void ctx.c.agentEvents.insertOne({
    callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, at: new Date(), utteranceId: u._id, kind: "context_window", lane: "fast",
    sections: [...records.use, ...win.use], estimatedTokens: records.tokens + win.tokens, droppedLines: records.dropped + win.dropped,
    inputTokens: stream.usage.input_tokens ?? null, outputTokens: stream.usage.output_tokens ?? null, cachedTokens: stream.usage.cache_read_input_tokens ?? 0,
    firstSentenceMs: firstMs, model: config.analyzeModel,
    // An answer that ran out of room is kept as written, to see what filled it (live Nov 14: 140 tokens, four words spoken).
    ...(stream.stopReason === "max_tokens" ? { cutRaw: raw.slice(0, 1200) } : {}),
  }).catch((e) => console.error("[window]", e instanceof Error ? e.message : e));
  // Spoken answers: whole sentences, about 42 words at most, no links (speech.ts).
  let full = spokenLine(raw.trim(), stream.stopReason === "max_tokens");
  // "I don't have anything on that yet" stands alone: nothing is added after it.
  if (!full || (!spoken && full.startsWith(NO_ANSWER))) full = NO_ANSWER;
  let rest = "";
  let text = full;
  if (spoken) {
    rest = restAfter(full, spoken);
    const bad = rest ? await ungrounded(rest) : [];
    if (bad.length) { await dropped(rest, bad); rest = ""; }
    text = rest ? `${spoken} ${rest}` : spoken;
  } else {
    const bad = await ungrounded(text);
    if (bad.length) { await dropped(text, bad); text = NO_ANSWER; }
  }
  // Links never go through the voice: every GitHub issue the answer names is posted in the Meet chat, once per call.
  // At most three per answer: "eight are open, 18 through 25" must not fill the chat.
  const links = issueLinks(text, process.env.GITHUB_REPO || "WagerWarrior/MongoDB").slice(0, 3);
  // The answer trace: what was searched, what came back and how long each step took, as one chat line.
  const trace = traceLine(config.agentName, {
    memoryOn, memoryKeys: memories.map((m) => String(m.key ?? "")).filter(Boolean), memoryMs: foundT.ms,
    knowledgeHits: knowledge.length, knowledgeMs: knowledgeT.ms,
    records: workspace.sources.length, openIssues: workspace.sources.filter((s) => /^issue #\d+ \[open\]/.test(s.line)).length,
    model: config.analyzeModel, modelMs, firstMs, totalMs: Date.now() - t0,
  });
  if (dry) {
    console.error(`[ask] trace: ${trace}`);
    for (const l of links) console.error(`[ask] would post in the Meet chat: ${l.url}`);
    return text;
  }
  for (const l of links) {
    void (async () => {
      if (await ctx.c.chatMessages.findOne({ callId: u.callId, url: l.url })) return;
      await postToMeetingChat(ctx, u.callId, `Issue #${l.number}: ${l.url}`, { url: l.url, label: `Issue #${l.number}`, source: "action" });
    })().catch((e) => console.error("[link]", e instanceof Error ? e.message : e));
  }
  if (!spoken) await say(voiceCtx, u.callId, text, "addressed", "high", u._id);
  else if (rest) {
    // Someone cut the first sentence off while the second was being written: the rest stays unsaid.
    const cutOff = await ctx.c.says.findOne({ callId: u.callId, utteranceId: u._id, reason: "addressed", status: "cancelled" }, { projection: { _id: 1 } });
    if (!cutOff) await say(voiceCtx, u.callId, rest, "addressed", "high", u._id);
  }
  if (firstMs !== null) void ctx.c.timings.insertOne({ callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, stage: "fast_first_sentence", ms: firstMs, at: new Date(), utteranceId: u._id }).catch(() => {});
  // After the voice is queued, so the trace never delays the answer.
  if (chatTraceOn()) void postToMeetingChat(ctx, u.callId, trace).catch((e) => console.error("[trace]", e instanceof Error ? e.message : e));
  await ctx.c.timings.insertOne({ callId: u.callId, teamId: ctx.teamId, projectId: ctx.projectId, stage: "fast_reply", ms: Date.now() - t0, at: new Date(), utteranceId: u._id });
  return text;
}
