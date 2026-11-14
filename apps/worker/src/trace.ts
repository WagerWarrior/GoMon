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
    ? "memory is off for this call"
    : `Atlas memory search: ${t.memoryKeys.length ? `${t.memoryKeys.length} hits (${shown}${more})` : "no hits"} in ${secs(t.memoryMs)}`;
  const steps = [
    memory,
    ...(t.memoryOn ? [`past meetings and ADRs: ${t.knowledgeHits} ${t.knowledgeHits === 1 ? "hit" : "hits"} in ${secs(t.knowledgeMs)}`] : []),
    `read ${t.records} team records, ${t.openIssues} open GitHub ${t.openIssues === 1 ? "issue" : "issues"}`,
    `${modelLabel(t.model)} wrote the answer in ${secs(t.modelMs)}`,
  ];
  return `${name} · how I answered (${secs(t.totalMs)}): ${steps.join(" · ")}`;
}

export const chatTraceOn = () => process.env.CHAT_TRACE !== "off";
