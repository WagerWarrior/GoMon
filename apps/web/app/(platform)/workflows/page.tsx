import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import FlowDiagram from "@/components/platform/FlowDiagram";
import { storedWorkflows, toolName, workflowRuns, type Run, type Step } from "@/lib/workflows";
import WorkflowToggle from "@/components/platform/WorkflowToggle";
import { overview, sessions } from "@/lib/platform";
import { when } from "@/lib/format";
export const dynamic = "force-dynamic";

export default async function Workflows() {
  const [{ runs, tools, totals }, stored, list, o] = await Promise.all([workflowRuns(), storedWorkflows(), sessions(), overview()]);
  const voice = list.filter((x) => x.voice).length;
  const inputs = [
    { name: "Meetings", sub: "Recall bot hears the call", n: `${voice} sessions` },
    { name: "Typed prompts", sub: "operator and chat messages", n: `${list.length - voice} sessions` },
  ];
  const brain = [{ k: "utterances", n: o.kpi.utterances }, { k: "memories", n: o.kpi.memories }, { k: "decisions locked", n: o.kpi.locked }];
  const outputs = [{ name: "Voice", n: `${o.kpi.says} lines` }, ...tools.map((t: any) => ({ name: t.name, n: `${t.done} sent` }))];
  const title = new Map(list.map((s) => [s.id, s]));
  return (
    <>
      <AutoRefresh />
      <header className="p-head"><div><h1>Workflows</h1><span className="eyebrow">Locked decisions, sent to the tools you have connected</span></div></header>

      <section className="p-card">
        <div className="p-card-h"><h2>What flows into Atlas</h2><span className="muted small">live counts</span></div>
        <div className="wf-sys">
          <div className="wf-col"><span className="eyebrow">In</span>{inputs.map((x) => <div key={x.name} className="wf-box"><b>{x.name}</b><span className="muted small">{x.sub}</span><span className="mono small">{x.n}</span></div>)}</div>
          <div className="wf-arrow" aria-hidden><i /></div>
          <div className="wf-col"><span className="eyebrow">Atlas brain</span><div className="wf-box wf-brain"><b>MongoDB Atlas</b>{brain.map((x) => <span key={x.k} className="small"><span className="mono">{x.n}</span> {x.k}</span>)}<span className="muted small">governed: lock, veto, audit</span></div></div>
          <div className="wf-arrow" aria-hidden><i /></div>
          <div className="wf-col"><span className="eyebrow">Out</span>{outputs.map((x) => <div key={x.name} className="wf-box"><b>{x.name}</b><span className="mono small">{x.n}</span></div>)}</div>
        </div>
      </section>

      <section className="p-card">
        <div className="p-card-h"><h2>Decision path</h2><span className="muted small">{totals.runs} decisions · {totals.confirmed} confirmed</span></div>
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


      <section className="p-card p-flush">
        <div className="p-card-h mx-pad"><h2>Latest runs</h2><span className="muted small">{totals.runs} decisions · newest first</span></div>
        <ul className="tk">
          {(runs as Run[]).slice(0, 12).map((r) => {
            const s = r.callId ? title.get(r.callId) : undefined;
            return (
              <li key={r.id}>
                <span className="tk-key mono">{r.key ?? "—"}</span>
                <span className="tk-main"><b>{r.title}</b>{r.callId && <Link href={`/sessions/${encodeURIComponent(r.callId)}?tab=activity`} className="muted small">{s?.title ?? r.callId}</Link>}</span>
                <span className="tk-steps">{r.steps.filter((x) => x.key !== "meeting").map((x) => <Dot key={x.key} s={x} />)}</span>
                <span className="muted small">{when(r.at)}</span>
              </li>
            );
          })}
        </ul>
      </section>
      {!runs.length && <section className="p-card"><div className="p-empty">No runs yet. Lock a decision in a call.</div></section>}
    </>
  );
}

function Dot({ s }: { s: Step }) {
  const el = <span className={`wf-dot s-${s.state}`} title={`${s.label}: ${s.detail ?? s.state}`}><i />{s.label}</span>;
  return s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="wf-link">{el}</a> : el;
}
