import GomonAvatar from "@/components/GomonAvatar";
import { system } from "@/lib/platform";
export const dynamic = "force-dynamic";

export default function System() {
  const s = system();
  return (
    <>
      <header className="p-head"><div><span className="eyebrow">{s.scope.teamId} / {s.scope.projectId}</span><h1>Models &amp; voice</h1></div></header>
      <section className="p-models">
        {s.models.map((m) => (
          <div key={m.role} className="p-card p-model">
            <div className="p-card-h"><h2>{m.role}</h2><span className={`pill ${m.ready ? "good" : "warn"}`}>{m.ready ? "Connected" : "Key missing"}</span></div>
            <b className="p-model-name">{m.name}</b>
            <span className="muted small">{m.provider}</span>
            <p className="muted">{m.note}</p>
          </div>
        ))}
      </section>
      <section className="p-row p-row-1-1">
        <div className="p-card">
          <div className="p-card-h"><h2>Connectors</h2></div>
          <table className="p-table"><tbody>{s.connectors.map((c) => <tr key={c.name}><td><b>{c.name}</b></td><td className="muted">{c.detail}</td><td><span className={`pill ${c.ready ? "good" : "warn"}`}>{c.ready ? "Ready" : "Not set"}</span></td></tr>)}</tbody></table>
        </div>
        <div className="p-card">
          <div className="p-card-h"><h2>Rules</h2></div>
          <table className="p-table"><tbody>{s.rules.map((r) => <tr key={r.name}><td>{r.name}</td><td className="mono">{r.value}</td></tr>)}</tbody></table>
        </div>
      </section>
      <section className="p-card p-voice">
        <GomonAvatar state="speaking" size={88} />
        <div><span className="eyebrow">Who runs the meeting</span><p>Gomon joins as a meeting bot, listens to every speaker, recalls team memory, and speaks only on its wake word, a conflict, or a lock. Anyone in the call can veto a lock within the window above.</p></div>
      </section>
    </>
  );
}
