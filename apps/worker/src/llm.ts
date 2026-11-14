import { traceable } from "langsmith/traceable";
import { config } from "./config.ts";
import { ITEM_KINDS, type ItemKind } from "./shapes.ts";

export type TurnLine = { id: string; speaker: string; text: string };
export type OpenItem = { id: string; kind: ItemKind; text: string; status: string };
export type MemoryLine = { id: string; key?: string; kind: string; text: string };

export type CommandType = "none" | "lock_item" | "create_tickets" | "post_slack" | "correct_memory" | "forget_memory";

/** One structured result per committed utterance: everything the loop needs, in a single fast model call. */
export type Analysis = {
  addressed: boolean;
  reply: string;
  newItems: { kind: ItemKind; text: string }[];
  conflicts: { itemRef: string; memoryId: string; severity: "high" | "medium" | "low"; kind: "conflict" | "already_decided"; note: string }[];
  agreement: { itemRefs: string[]; agreedBy: string[] };
  objection: boolean;
  command: { type: CommandType; memoryId: string; itemRef: string; newText: string };
  suggestion: string;
};

const str = { type: "string" };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["addressed", "reply", "newItems", "conflicts", "agreement", "objection", "command", "suggestion"],
  properties: {
    addressed: { type: "boolean" },
    reply: str,
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
      type: "object", additionalProperties: false, required: ["type", "memoryId", "itemRef", "newText"],
      properties: { type: { type: "string", enum: ["none", "lock_item", "create_tickets", "post_slack", "correct_memory", "forget_memory"] }, memoryId: str, itemRef: str, newText: str },
    },
    suggestion: str,
  },
} as const;

function system(name: string): string {
  return `You are ${name}, an AI participant in a live engineering design call. You read the newest committed utterances (one or more).
Transcripts come from live speech-to-text: often lowercase, unpunctuated, and split mid-thought across utterances. Read them together.
Return JSON only, matching the schema. Be conservative and BRIEF (latency matters): an empty result is correct for small talk and filler.

Rules:
- addressed: true if a new utterance speaks to you by name. Speech-to-text never spells your name right ("goman", "gourmand", "so man",
  "go on", "no man"); WAKE lines list utterances a sound-alike matcher already flagged as addressed to you.
- reply: if addressed, a short spoken answer (max 35 words, no markdown, no lists). Ground it ONLY in the provided memories and
  call items and cite memory keys like "R-12" when you use them. If the memories do not contain the answer, say so. Empty if not addressed.
- newItems: high-level design content stated in the NEW utterances (decision proposals, requirements, constraints, risks, open questions,
  action items with owner, assumptions, interfaces, alternatives). Max 3 items, each max 25 words, self-contained. A single proposal
  with several parts is ONE decision item that summarizes all parts. Do not repeat an existing open item. Never low-level detail.
- conflicts: for each new item ("new:<index>") or open item (its id) that contradicts a memory, give memoryId and a note (max 25
  words, spoken aloud) naming the memory key and the specific clash. kind "already_decided" when the team re-debates something a
  memory already settles. severity "high" only for direct contradictions of a decision or customer requirement.
- agreement: when a new utterance expresses team agreement with proposed item(s) ("let's do that", "agreed", "sounds good, ship it"),
  itemRefs = those items ("new:<index>" or ids; usually the latest proposal) and agreedBy = speakers who agreed. Otherwise [] and [].
- objection: true if the speaker pushes back on something being locked ("wait", "no", "hold on", "not yet").
- command: only when the speaker explicitly asks you: "lock it in" -> lock_item (itemRef); "create the tickets" -> create_tickets;
  "post it to Slack" -> post_slack; "correct that, X is Y" -> correct_memory (memoryId of the memory being corrected, newText = the
  full corrected memory text); "forget that" -> forget_memory (memoryId). Otherwise type "none" with empty fields.
- suggestion: only a strong, specific alternative design (max 30 words) that the memories support and nobody has raised; usually empty.`;
}

function user(recent: TurnLine[], batch: TurnLine[], items: OpenItem[], memories: MemoryLine[], wake: { id: string; heardAs: string }[]): string {
  const fmt = (l: TurnLine) => `[${l.id}] ${l.speaker}: ${l.text}`;
  return [
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

export const analyze = traceable(
  async (recent: TurnLine[], batch: TurnLine[], items: OpenItem[], memories: MemoryLine[], wake: { id: string; heardAs: string }[]): Promise<Analysis> => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": config.llmKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: config.analyzeModel,
        max_tokens: 2048,
        system: system(config.agentName),
        messages: [{ role: "user", content: user(recent, batch, items, memories, wake) }],
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
