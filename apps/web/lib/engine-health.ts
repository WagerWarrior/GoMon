/**
 * The agent loop as a pipeline, with a verdict per stage and for the whole engine. Pure: the numbers come from Atlas
 * (timings, utterances, agent_events) through lib/engine.ts. Targets are the same SLOs the Benchmarks card uses.
 */
export type StageNum = { p50: number | null; p95: number | null; n: number };
export type EngineInput = {
  stages: Record<string, StageNum>;
  workers: { id: string; lastAt: string; n: number }[];
  failed: number; backlog: number; heard15: number; sources: Record<string, number>; model: string | null;
};
export type Tone = "good" | "warn" | "bad" | "idle";
export type Node = { key: string; label: string; what: string; p50: number | null; p95: number | null; target?: number; tone: Tone; note?: string };

const TARGET: Record<string, number> = { queue: 1500, retrieve: 500, analyze: 2500, say_to_audio: 1500, total: 2500 };
const tone = (s: StageNum | undefined, target?: number): Tone => (!s || s.p50 == null ? "idle" : target == null ? "good" : s.p50 <= target ? "good" : s.p50 <= target * 2 ? "warn" : "bad");

export function pipeline(e: EngineInput): Node[] {
  const st = (k: string) => e.stages[k];
  const src = Object.entries(e.sources).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ");
  const node = (key: string, label: string, what: string, note?: string): Node => ({ key, label, what, p50: st(key)?.p50 ?? null, p95: st(key)?.p95 ?? null, target: TARGET[key], tone: tone(st(key), TARGET[key]), note });
  return [
    { key: "hear", label: "Hear", what: "Committed transcript segments land in utterances", p50: null, p95: null, tone: e.heard15 ? "good" : "idle", note: e.heard15 ? `${e.heard15} in 15 min${src ? ` · ${src}` : ""}` : "nothing in 15 min" },
    node("queue", "Queue", "Change stream wakes the worker; short segments merge"),
    node("retrieve", "Recall", "Atlas $rankFusion: vector (auto-embedded) + text"),
    node("analyze", "Think", "One structured model call per batch", e.model ?? undefined),
    { key: "act", label: "Write", what: "Items, locks, says, actions and audit in Atlas", p50: null, p95: null, tone: e.failed ? "bad" : "good", note: e.failed ? `${e.failed} failed batch${e.failed > 1 ? "es" : ""}` : "no failed batches" },
    node("say_to_audio", "Speak", "Say row to audio in the meeting"),
  ];
}

/** Hear-to-spoken: the loop (total) plus speech. Null until both were measured. */
export const endToEnd = (e: EngineInput) => (e.stages.total?.p50 != null && e.stages.say_to_audio?.p50 != null ? e.stages.total.p50 + e.stages.say_to_audio.p50 : null);

/** Engine-wide problems, worst first. One live worker per database is the rule (checkpoint plan). */
export function problems(e: EngineInput, now = Date.now()): { tone: Tone; text: string }[] {
  const out: { tone: Tone; text: string }[] = [];
  // Worker ids are host:pid. A restart is a new pid on the same host, so count machines, not processes.
  const hosts = [...new Set(e.workers.filter((w) => now - +new Date(w.lastAt) < 15 * 60_000).map((w) => w.id.split(":")[0]))];
  if (hosts.length > 1) out.push({ tone: "bad", text: `${hosts.length} machines ran a worker on this database in the last 15 min (${hosts.map((h) => h.replace(/\.local$/, "")).join(", ")}); only one should` });
  if (e.failed) out.push({ tone: "bad", text: `${e.failed} batch${e.failed > 1 ? "es" : ""} failed and were not retried: nobody heard an answer` });
  if (e.backlog) out.push({ tone: "warn", text: `${e.backlog} utterance${e.backlog > 1 ? "s" : ""} waiting over 30 s: no worker is draining this database` });
  const slow = pipeline(e).filter((n) => n.tone === "bad");
  for (const n of slow) out.push({ tone: "warn", text: `${n.label} p50 ${n.p50} ms is over twice its ${n.target} ms target` });
  return out;
}
