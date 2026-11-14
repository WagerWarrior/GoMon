import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import { storedWorkflows, workflowRuns, type Step } from "@/lib/workflows";
import WorkflowToggle from "@/components/platform/WorkflowToggle";
import { system } from "@/lib/platform";
import { when } from "@/lib/format";
export const dynamic = "force-dynamic";

const FLOW = [
  { key: "meeting", title: "Meeting", sub: "Recall bot hears the call" },
  { key: "lock", title: "Decision locks", sub: "consensus or a click, veto window" },
  { key: "policy", title: "Policy", sub: "role may act" },
  { key: "slack", title: "Slack", sub: "post in the call thread" },
  { key: "github", title: "GitHub", sub: "open an issue" },
  { key: "confirm", title: "Read-back", sub: "verify it landed" },
];

export default async function Workflows() {
  const [{ runs, totals }, stored] = await Promise.all([workflowRuns(), storedWorkflows()]); const sys = system();
  const ready: Record<string, boolean> = Object.fromEntries(sys.connectors.map((c) => [c.name, c.ready]));
  // The connectors service holds the tokens, not this server: a confirmed send also proves the connector works.
  ready.Slack ||= totals.slack > 0; ready["GitHub issues"] ||= totals.github > 0;
  return (
    <>
      <AutoRefresh />
      <header className="p-head"><div><h1>Workflows</h1><span className="eyebrow">Locked decision → Slack → GitHub</span></div></header>

      {stored.map((w: any) => (
        <section key={w._id} className="p-card wf-flow">
          <div className="p-card-h"><h2>{w.name}</h2><div className="p-head-r"><span className="muted small">fired {w.fired}×{w.lastFired ? ` · last ${when(w.lastFired)}` : ""}</span><WorkflowToggle id={w._id} enabled={w.enabled} /></div></div>
          <div className="wf-chain">
            <span className="wf-chip trig">When {String(w.trigger).replace(/_/g, " ")}</span>
            {w.steps.map((st: any, i: number) => <span key={i} className="wf-chip"><em>→</em>{st.type === "post_slack" ? "Post to Slack thread" : st.type === "create_issue" ? "Open GitHub issue" : st.type}</span>)}
            <span className="wf-chip"><em>→</em>Policy check + read-back</span>
          </div>
        </section>
      ))}

      <section className="p-card wf-flow">
        <div className="p-card-h"><h2>How a decision becomes a ticket</h2></div>
        <ol>
          {FLOW.map((f, i) => (
            <li key={f.key}>
              <span className="wf-n">{String(i + 1).padStart(2, "0")}</span>
              <b>{f.title}</b><span className="muted small">{f.sub}</span>
              {f.key === "slack" && <span className={`pill ${ready.Slack ? "good" : "warn"}`}>{ready.Slack ? "connected" : "not set"}</span>}
              {f.key === "github" && <span className={`pill ${ready["GitHub issues"] ? "good" : "warn"}`}>{ready["GitHub issues"] ? "connected" : "not set"}</span>}
              {f.key === "meeting" && <span className="pill good">trigger</span>}
            </li>
          ))}
        </ol>
      </section>

      <section className="p-kpis p-kpis-4">
        <div className="p-kpi"><span className="eyebrow">Runs</span><b>{totals.runs}</b></div>
        <div className="p-kpi"><span className="eyebrow">Slack posts</span><b>{totals.slack}</b></div>
        <div className="p-kpi"><span className="eyebrow">GitHub issues</span><b>{totals.github}</b></div>
        <div className="p-kpi"><span className="eyebrow">Confirmed</span><b>{totals.confirmed}</b></div>
      </section>

      <section className="p-card p-flush">
        <table className="p-table wf-runs">
          <thead><tr><th>Decision</th><th>When</th>{FLOW.map((f) => <th key={f.key}>{f.title}</th>)}</tr></thead>
          <tbody>
            {runs.map((r: any) => (
              <tr key={r.id}>
                <td className="p-wide"><b className="mono">{r.key ?? ""}</b> {r.title}{r.callId && <span className="muted small p-id"><Link href={`/sessions/${encodeURIComponent(r.callId)}`}>{r.callId}</Link></span>}</td>
                <td className="small muted">{when(r.at)}</td>
                {r.steps.map((s: Step) => <td key={s.key}><Dot s={s} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {!runs.length && <div className="p-empty">No runs yet. Lock a decision in a call.</div>}
      </section>
    </>
  );
}

function Dot({ s }: { s: Step }) {
  const el = <span className={`wf-dot s-${s.state}`} title={s.detail ?? s.state}><i />{s.state === "skipped" ? "—" : s.state}</span>;
  return s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="wf-link">{el}</a> : el;
}
