import { traceable } from "langsmith/traceable";
import { config } from "./config.ts";
import { ITEM_KINDS, type ItemKind } from "./shapes.ts";
import type { Workspace } from "./context.ts";

export type TurnLine = { id: string; speaker: string; text: string };
export type OpenItem = { id: string; kind: ItemKind; text: string; status: string };
export type MemoryLine = { id: string; key?: string; kind: string; text: string };

export type CommandType = "none" | "lock_item" | "create_tickets" | "post_slack" | "correct_memory" | "forget_memory" | "share_link";

/** One structured result per committed utterance: everything the loop needs, in a single fast model call. */
export type Analysis = {
  addressed: boolean;
  /** conversational: about the call itself; grounded: answered from provided context, cited in `sources`; no_answer: nothing provided covers it. */
  replyKind: "none" | "conversational" | "grounded" | "no_answer";
  reply: string;
  /** Context ids the reply relied on: memory keys ("R-12"), GitHub refs ("#9"), "call:<id>", "atlas", or open item ids. */
  sources: string[];
  newItems: { kind: ItemKind; text: string }[];
  conflicts: { itemRef: string; memoryId: string; severity: "high" | "medium" | "low"; kind: "conflict" | "already_decided"; note: string }[];
  agreement: { itemRefs: string[]; agreedBy: string[] };
  objection: boolean;
  command: { type: CommandType; memoryId: string; itemRef: string; newText: string; query: string };
  suggestion: string;
};

const str = { type: "string" };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["addressed", "replyKind", "reply", "sources", "newItems", "conflicts", "agreement", "objection", "command", "suggestion"],
  properties: {
    addressed: { type: "boolean" },
    replyKind: { type: "string", enum: ["none", "conversational", "grounded", "no_answer"] },
    reply: str,
    sources: { type: "array", items: str },
    newItems: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["kind", "text"], properties: { kind: { type: "string", enum: [...ITEM_KINDS] }, text: str } },
    },
    conflicts: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["itemRef", "memoryId", "severity", "kind", "note"],
        properties: { itemRef: str, memoryId: str, severity: { type: "string", enum: ["high", "medium", "low"] }, kind: { type: "string", enum: ["conflict", "already_decided"] }, note: str },
      },
    },
    agreement: { type: "object", additionalProperties: false, required: ["itemRefs", "agreedBy"], properties: { itemRefs: { type: "array", items: str }, agreedBy: { type: "array", items: str } } },
    objection: { type: "boolean" },
    command: {
      type: "object", additionalProperties: false, required: ["type", "memoryId", "itemRef", "newText", "query"],
      properties: { type: { type: "string", enum: ["none", "lock_item", "create_tickets", "post_slack", "correct_memory", "forget_memory", "share_link"] }, memoryId: str, itemRef: str, newText: str, query: str },
    },
    suggestion: str,
  },
} as const;

function system(name: string, persona: string, kinds: readonly string[]): string {
  return `You are ${name}, an AI participant in a live engineering design call. You read the newest committed utterances (one or more).
You already greeted the room when you joined; never greet again. You speak ONLY when someone talks to you. The single exception
is a serious interjection: a high-severity conflict (defined below). Everything else you notice goes to the dashboard silently.
Persona for this call: ${persona}
Capture only these item kinds: ${kinds.join(", ")}.
Transcripts come from live speech-to-text: often lowercase, unpunctuated, and split mid-thought across utterances. Read them together.
Return JSON only, matching the schema. Be conservative and BRIEF (latency matters): an empty result is correct for small talk and filler.

How you sound: like a sharp teammate on the call, not a system. Contractions, plain words, one idea per sentence. Lead with the
point ("Heads up, that clashes with R-12..."), never with a label ("Conflict:", "Per D-12:"). Don't repeat what was just said.
Say keys naturally once ("R-12 says Acme needs bursts up to 3,000 a second"). Numbers the way people say them.

Rules:
- addressed: true if a new utterance speaks to you by name. Speech-to-text never spells your name right ("goman", "gourmand", "so man",
  "go on", "no man"); WAKE lines list utterances a sound-alike matcher already flagged as addressed to you.
- reply (only if addressed, else "" with replyKind "none"): one or two short spoken sentences (max 30 words, no markdown, no lists).
  Answer what was actually asked; don't mention memory unless it matters.
  replyKind "conversational" for questions about you or this call ("can you hear me", "are you there", "what did I just say",
  "what have we covered"): answer naturally from RECENT TURNS and THIS CALL; sources [].
  replyKind "grounded" for anything about the team, the design, past calls, GitHub, or the database: use only MEMORIES, OPEN CALL
  ITEMS and WORKSPACE, put every id you relied on in sources (memory key, "#<n>", "call:<id>", "atlas", or item id), and name the
  key, issue number or call title naturally once. Never answer from general knowledge.
  replyKind "no_answer" if none of that covers it: say so in your own words in one short sentence, e.g. "I don't have anything on
  that yet." Never offer to log it.
- newItems: high-level design content stated in the NEW utterances (decision proposals, requirements, constraints, risks, open questions,
  action items with owner, assumptions, interfaces, alternatives). Max 3 items, each max 25 words, self-contained. A single proposal
  with several parts is ONE decision item that summarizes all parts. Do not repeat an existing open item. Never low-level detail.
- conflicts: for each new item ("new:<index>") or open item (its id) that contradicts a memory, give memoryId and a note (max 22
  words, spoken aloud in the voice above) naming the memory key and the specific clash. kind "already_decided" when the team re-debates
  something a memory already settles. severity "high" ONLY if adopting the item would break a locked decision or a customer
  requirement in MEMORIES (e.g. a limit an agreed customer need exceeds). Preferences, style, partial overlaps and anything
  hypothetical or exploratory ("what if", "maybe") are "medium" or "low". When unsure, it is not high.
- agreement: when a new utterance clearly expresses team agreement with proposed item(s) ("agreed", "let's do that", "sounds good,
  ship it", "yes let's go with that"), itemRefs = those items ("new:<index>" or ids; usually the latest proposal) and agreedBy =
  speakers who agreed (not the proposer alone). A bare "yeah", "mm", "right" or "okay" that the SAME speaker continues past is
  filler, not agreement. Never agree on behalf of silence. Otherwise [] and [].
- objection: true if the speaker pushes back on something being locked ("wait", "no", "hold on", "not yet").
- command: only when the speaker explicitly asks you: "lock it in" -> lock_item (itemRef); "create the tickets" -> create_tickets;
  "post it to Slack" -> post_slack; "correct that, X is Y" -> correct_memory (memoryId of the memory being corrected, newText = the
  full corrected memory text); "forget that" -> forget_memory (memoryId); "send/drop/share/post the link to X", "open the repo"
  -> share_link (memoryId if X is a memory, query = what they want a link to). Questions about issues, PRs or the repo ("what's the
  latest issue?") are replies grounded in WORKSPACE, not share_link. Otherwise type "none" with
  empty fields. Unused fields are "".
- suggestion: only a strong, specific alternative design (max 30 words) that the memories support and nobody has raised; almost always empty.`;
}

function user(recent: TurnLine[], batch: TurnLine[], items: OpenItem[], memories: MemoryLine[], wake: { id: string; heardAs: string }[], workspace: Workspace | null): string {
  const fmt = (l: TurnLine) => `[${l.id}] ${l.speaker}: ${l.text}`;
  return [
    ...(workspace ? ["THIS CALL:", workspace.header, "", "WORKSPACE (previous calls, GitHub, database):", ...workspace.sources.map((s) => `- id=${s.id} ${s.line}`), ""] : []),
    "MEMORIES (canonical team memory, retrieved for these utterances):",
    memories.length ? memories.map((m) => `- id=${m.id} key=${m.key ?? "-"} kind=${m.kind}: ${m.text}`).join("\n") : "(none)",
    "",
    "OPEN CALL ITEMS:",
    items.length ? items.map((i) => `- id=${i.id} [${i.status}] ${i.kind}: ${i.text}`).join("\n") : "(none)",
    "",
    "RECENT TURNS (already processed):",
    recent.length ? recent.map(fmt).join("\n") : "(start of call)",
    "",
    "NEW UTTERANCES:",
    batch.map(fmt).join("\n"),
    ...(wake.length ? ["", "WAKE (addressed to you):", ...wake.map((w) => `- [${w.id}] heard as "${w.heardAs}"`)] : []),
  ].join("\n");
}

type MessagesResponse = { content?: { type: string; text?: string }[]; stop_reason?: string; error?: { message: string }; usage?: unknown };

export type TemplateHints = { persona: string; captureKinds: readonly string[] };

export const analyze = traceable(
  async (recent: TurnLine[], batch: TurnLine[], items: OpenItem[], memories: MemoryLine[], wake: { id: string; heardAs: string }[], tpl: TemplateHints, workspace: Workspace | null = null): Promise<Analysis> => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": config.llmKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: config.analyzeModel,
        max_tokens: 2048,
        system: system(config.agentName, tpl.persona, tpl.captureKinds),
        messages: [{ role: "user", content: user(recent, batch, items, memories, wake, workspace) }],
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      }),
    });
    const body = (await res.json()) as MessagesResponse;
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? "unknown error"}`);
    const text = body.content?.find((b) => b.type === "text")?.text;
    if (!text || body.stop_reason !== "end_turn") throw new Error(`analysis incomplete (stop_reason=${body.stop_reason})`);
    return JSON.parse(text) as Analysis;
  },
  { name: "gomon.analyze", run_type: "llm", metadata: { model: config.analyzeModel } },
);
