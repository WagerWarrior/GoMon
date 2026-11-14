import { atlasPing, setup, system } from "@/lib/platform";
export const dynamic = "force-dynamic";

/** Models & voice: one row per service, what it does, what it needs, and whether it is ready. */
export default async function System() {
  const [rows, ping] = [setup(), await atlasPing()]; const s = system();
  const ready = rows.filter((r) => r.ready).length;
  return (
    <>
      <header className="p-head"><div><h1>Models &amp; voice</h1><span className="eyebrow">{ready} of {rows.length} ready · keys live in the repo-root .env, never in the browser</span></div></header>
      <section className="p-card p-flush">
        <table className="p-table su-table">
          <thead><tr><th>Service</th><th>Role</th><th>Using</th><th>Needs</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.name}>
              <td><b>{r.name}</b><span className="muted small p-id su-does">{r.does}</span></td>
              <td className="small">{r.role}</td>
              <td className="mono small">{r.value}{r.name === "MongoDB Atlas" && <span className="muted"> · ping {ping.ok ? `${ping.ms}ms` : "failed"}</span>}</td>
              <td><span className="su-keys">{r.keys.map((k) => <code key={k.k} data-set={k.set ? "1" : undefined}>{k.set ? "✓" : "○"} {k.k}</code>)}</span></td>
              <td><span className={`pill ${r.ready ? "good" : "warn"}`}>{r.ready ? "Ready" : "Add key"}</span></td>
            </tr>
          ))}</tbody>
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
