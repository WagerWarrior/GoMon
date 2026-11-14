/**
 * The engine at a glance: the agent loop as six stages (hear, queue, recall, think, write, speak) with measured p50/p95
 * against target, hear-to-spoken end to end, the workers on this database, and anything wrong, worst first.
 * Every number is read from Atlas; LangSmith holds the per-call traces (gomon.handleBatch -> gomon.analyze).
 */
import { answerPath, endToEnd, pipeline, problems } from "@/lib/engine-health";
import type { engine } from "@/lib/engine";
import { ms } from "@/lib/format";

const ago = (iso: string) => { const s = Math.round((Date.now() - +new Date(iso)) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

export default function EngineCard({ e }: { e: Awaited<ReturnType<typeof engine>> }) {
  const nodes = pipeline(e); const total = endToEnd(e); const issues = problems(e);
  const over = nodes.filter((n) => n.tone === "warn" || n.tone === "bad");
  const live = e.workers.filter((w) => Date.now() - +new Date(w.lastAt) < 15 * 60_000);
  return (
    <section className="p-card en">
      <div className="p-card-h">
        <h2>Engine</h2>
        <span className="muted small">{e.window} · traces in LangSmith project <span className="mono">gomon</span></span>
      </div>
      <div className="en-head">
        <div className="en-big"><span className="eyebrow">Question → spoken p50</span><b>{ms(total)}</b><span className="muted small">{answerPath(e)?.label ?? "loop"} {ms(answerPath(e)?.p50 ?? null)} + speech {ms(e.stages.say_to_audio?.p50 ?? null)}{e.stages.fast_reply ? ` · background loop ${ms(e.stages.total?.p50 ?? null)}` : ""}</span></div>
        <div className={`en-verdict ${issues.some((i) => i.tone === "bad") ? "bad" : issues.length || over.length ? "warn" : "good"}`}>
          <i />{issues.length ? issues[0].text : `Loop healthy: one worker, no failed batches, nothing waiting${over.length ? `. Over target: ${over.map((n) => n.label).join(", ")}` : ""}`}
        </div>
      </div>
      <ol className="en-pipe">
        {nodes.map((n) => (
          <li key={n.key} className={`t-${n.tone}`}>
            <span className="en-dot" />
            <b>{n.label}</b>
            <span className="en-ms">{n.p50 != null ? ms(n.p50) : n.note ? "" : "—"}{n.p95 != null && <em> p95 {ms(n.p95)}</em>}</span>
            {n.target && <span className="en-target">target {ms(n.target)}</span>}
            <span className="en-what">{n.what}</span>
            {n.note && <span className="en-note">{n.note}</span>}
          </li>
        ))}
      </ol>
      {issues.length > 1 && <ul className="en-issues">{issues.slice(1).map((i) => <li key={i.text} className={`t-${i.tone}`}>{i.text}</li>)}</ul>}
      <div className="en-workers">
        <span className="eyebrow">Workers on this database, last hour</span>
        {e.workers.length ? e.workers.map((w) => <span key={w.id} className={`en-w ${live.includes(w) ? "on" : ""}`}><i />{w.id.replace(/\.local/, "")}<em>{w.n} claimed · {ago(w.lastAt)}</em></span>) : <span className="muted small">none</span>}
      </div>
    </section>
  );
}
