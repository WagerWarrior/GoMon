import { atlasPing, overview, setup, system } from "@/lib/platform";
import { workflowRuns } from "@/lib/workflows";
import KeyHelp from "@/components/platform/KeyHelp";
export const dynamic = "force-dynamic";

/** Models & voice: one row per service, what it does, what it needs, and whether it is ready. */
export default async function System() {
  const [ping, o, wf] = await Promise.all([atlasPing(), overview(), workflowRuns()]); const rows = setup(); const s = system();
  // Some keys live with another service (worker, connectors, bot page), not this web server. Real use counts as proof it works.
  const stage = (k: string) => o.stages.find((x: any) => x.stage === k)?.n ?? 0;
  const tool = (t: string) => wf.tools.find((x: any) => x.type === t)?.done ?? 0;
  const seen: Record<string, string | null> = {
    "Reasoning model": stage("analyze") ? `${stage("analyze")} runs` : null,
    "Embeddings": stage("retrieve") ? `${stage("retrieve")} searches` : null,
    "Meeting bot": o.reliability.botJoined ? `joined ${o.reliability.botJoined} sessions` : null,
    "Voice": o.kpi.says ? `${o.kpi.says} lines spoken` : null,
    "Slack": tool("post_slack") ? `${tool("post_slack")} posts` : null,
    "GitHub": tool("create_issue") ? `${tool("create_issue")} issues` : null,
  };
  const state = (r: (typeof rows)[number]) => (r.ready ? "ready" : seen[r.name] ? "working" : "missing");
  const ready = rows.filter((r) => state(r) !== "missing").length;
  return (
    <>
      <header className="p-head"><div><h1>Integrations</h1><span className="eyebrow">{ready} of {rows.length} working · keys live in the repo-root .env, never in the browser</span></div></header>
      <section className="p-card p-flush">
        <table className="p-table su-table">
          <thead><tr><th>Service</th><th>Role</th><th>Using</th><th>Keys</th><th>Status</th><th></th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.name}>
              <td><b>{r.name}</b><span className="muted small p-id su-does">{r.does}</span></td>
              <td className="small">{r.role}</td>
              <td className="mono small">{r.value}{r.name === "MongoDB Atlas" && <span className="muted"> · ping {ping.ok ? `${ping.ms}ms` : "failed"}</span>}</td>
              <td><span className="su-keys">{r.keys.map((k) => <code key={k.k} data-set={k.set ? "1" : undefined}>{k.set ? "✓" : "○"} {k.k}</code>)}</span></td>
              <td><span className={`su-state s-${state(r)}`}><i />{state(r) === "ready" ? "Ready" : state(r) === "working" ? "Working" : "Missing keys"}</span>{seen[r.name] && <span className="muted small p-id">{seen[r.name]}</span>}</td>
              <td>{state(r) === "missing" ? <KeyHelp name={r.name} missing={r.keys.filter((k) => !k.set).map((k) => k.k)} /> : null}</td>
            </tr>
          ))}
            <tr><td><b>Email</b><span className="muted small p-id su-does">Email decision summaries after a call.</span></td><td className="small">Sends</td><td className="mono small muted">not built</td><td></td><td><span className="su-state"><i style={{ background: "#d0cec8" }} />Not available yet</span></td><td></td></tr>
          </tbody>
        </table>
      </section>
      <section className="p-row p-row-1-1">
        <div className="p-card">
          <div className="p-card-h"><h2>Set up in three steps</h2></div>
          <ol className="su-steps">
            <li><b>Copy the example env.</b><code>cp .env.example .env</code></li>
            <li><b>Paste the keys marked ○ above.</b><span className="muted small">Atlas, the reasoning key and Recall are the minimum for a live call.</span></li>
            <li><b>Start it.</b><code>npm run demo</code><span className="muted small">in apps/web, plus the worker and the bot page</span></li>
          </ol>
        </div>
        <div className="p-card">
          <div className="p-card-h"><h2>Rules</h2></div>
          <table className="p-table"><tbody>{s.rules.map((r) => <tr key={r.name}><td>{r.name}</td><td className="mono">{r.value}</td></tr>)}</tbody></table>
        </div>
      </section>
    </>
  );
}
