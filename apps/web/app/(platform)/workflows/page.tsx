import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import FlowDiagram from "@/components/platform/FlowDiagram";
import { storedWorkflows, toolName, workflowRuns, type Run, type Step } from "@/lib/workflows";
import WorkflowToggle from "@/components/platform/WorkflowToggle";
import { sessions } from "@/lib/platform";
import { when } from "@/lib/format";
export const dynamic = "force-dynamic";

export default async function Workflows() {
  const [{ runs, tools, totals }, stored, list] = await Promise.all([workflowRuns(), storedWorkflows(), sessions()]);
  const title = new Map(list.map((s) => [s.id, s]));
  // One group per session: many conversations at once stay readable.
  const groups = new Map<string, Run[]>();
  for (const r of runs as Run[]) { const k = r.callId ?? "—"; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  const cols: { key: string; label: string }[] = (runs[0]?.steps ?? []).map((s: Step) => ({ key: s.key, label: s.label }));
  return (
    <>
      <AutoRefresh />
      <header className="p-head"><div><h1>Workflows</h1><span className="eyebrow">Locked decisions, sent to the tools you have connected</span></div></header>

      <section className="p-card">
        <div className="p-card-h"><h2>All sessions</h2><span className="muted small">{totals.runs} decisions · {totals.confirmed} confirmed</span></div>
        <FlowDiagram runs={runs} />
      </section>

      {stored.length > 0 && (
        <section className="p-card">
          <div className="p-card-h"><h2>Automations</h2></div>
          <div className="wf-autos">
            {stored.map((w: any) => (
              <div key={w._id} className="wf-auto">
                <div className="wf-chain">
                  <span className="wf-chip trig">When {String(w.trigger).replace(/_/g, " ")}</span>
                  {w.steps.map((st: any, i: number) => <span key={i} className="wf-chip"><em>→</em>{toolName(st.type)}</span>)}
                </div>
                <span className="muted small">{w.name} · fired {w.fired}×{w.lastFired ? ` · last ${when(w.lastFired)}` : ""}</span>
                <WorkflowToggle id={w._id} enabled={w.enabled} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="p-kpis" style={{ gridTemplateColumns: `repeat(${2 + tools.length},minmax(0,1fr))` }}>
        <div className="p-kpi"><span className="eyebrow">Decisions</span><b>{totals.runs}</b></div>
        {tools.map((t: any) => <div key={t.type} className="p-kpi"><span className="eyebrow">{t.name}</span><b>{t.done}</b></div>)}
        <div className="p-kpi"><span className="eyebrow">Confirmed</span><b>{totals.confirmed}</b></div>
      </section>

      {[...groups.entries()].map(([callId, rs]) => {
        const s = title.get(callId);
        return (
          <section key={callId} className="p-card p-flush">
            <div className="p-card-h mx-pad">
              <h2>{callId === "—" ? "No session" : <Link href={`/sessions/${encodeURIComponent(callId)}?tab=events`}>{s?.title ?? callId}</Link>}</h2>
              <span className="muted small">{s?.category ? `${s.category} · ` : ""}{rs.length} decision{rs.length === 1 ? "" : "s"}</span>
            </div>
            <table className="p-table wf-runs">
              <thead><tr><th>Decision</th><th>When</th>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {rs.map((r) => (
                  <tr key={r.id}>
                    <td className="p-wide"><b className="mono">{r.key ?? ""}</b> {r.title}</td>
                    <td className="small muted">{when(r.at)}</td>
                    {cols.map((c) => { const st = r.steps.find((x) => x.key === c.key); return <td key={c.key}>{st ? <Dot s={st} /> : "—"}</td>; })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
      {!runs.length && <section className="p-card"><div className="p-empty">No runs yet. Lock a decision in a call.</div></section>}
    </>
  );
}

function Dot({ s }: { s: Step }) {
  const el = <span className={`wf-dot s-${s.state}`} title={s.detail ?? s.state}><i />{s.state === "skipped" ? "—" : s.state}</span>;
  return s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="wf-link">{el}</a> : el;
}
