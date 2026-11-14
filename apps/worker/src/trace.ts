/**
 * The answer trace (Max, Nov 14): one short line in the Google Meet chat after each answer, saying what Gomon searched, what
 * came back and how long each step took, so the room can see how it got there. Pure, tested in test/trace.test.ts.
 * CHAT_TRACE=off turns it off.
 */
export type Trace = {
  memoryOn: boolean;
  memoryKeys: string[]; memoryMs: number;
  knowledgeHits: number; knowledgeMs: number;
  records: number; openIssues: number;
  model: string; modelMs: number; totalMs: number;
  /** When the first sentence went to the voice, counted from the question (null: the answer was spoken in one piece). */
  firstMs?: number | null;
};

const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

/** "claude-sonnet-5-5" -> "Sonnet 5.5". An id in another shape is shown as it is. */
export function modelLabel(id: string): string {
  const m = /(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id;
}

export function traceLine(name: string, t: Trace): string {
  const shown = t.memoryKeys.slice(0, 4).join(", ");
  const more = t.memoryKeys.length > 4 ? `, +${t.memoryKeys.length - 4}` : "";
  const memory = !t.memoryOn
    ? "memory off for this call"
    : `Atlas memory: ${t.memoryKeys.length ? `${t.memoryKeys.length} hits (${shown}${more})` : "no hits"}`;
  const steps = [
    memory,
    ...(t.memoryOn ? [`Past meetings: ${t.knowledgeHits} ${t.knowledgeHits === 1 ? "hit" : "hits"}`] : []),
    `Tickets: ${t.openIssues} open, ${t.records} records read`,
    `${modelLabel(t.model)}: ${secs(t.modelMs)}${t.firstMs != null ? ` (first sentence at ${secs(t.firstMs)})` : ""}`,
  ];
  return `${name} answered in ${secs(t.totalMs)}  |  ${steps.join("  |  ")}`;
}

export const chatTraceOn = () => process.env.CHAT_TRACE !== "off";
