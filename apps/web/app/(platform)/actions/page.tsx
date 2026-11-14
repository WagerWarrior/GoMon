import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import { actions, sessions } from "@/lib/platform";
import { groupBy } from "@/lib/group";
import { toolName } from "@/lib/workflows";
import { describeAction } from "@/lib/actions";
import { when } from "@/lib/format";
export const dynamic = "force-dynamic";

const tone = (s: string) => (s === "confirmed" || s === "sent" ? "good" : s === "failed" || s === "denied" ? "bad" : s === "needs_review" ? "warn" : "");

/** The outbox, grouped by the session that asked for each action, with a status summary on top. */
export default async function Actions() {
  const [rows, list] = await Promise.all([actions(), sessions()]);
  const meta = new Map(list.map((s) => [s.id, s]));
  const status = groupBy(rows, (a: any) => String(a.status)).map(([k, v]) => [k, v.length] as const);
  const byTool = groupBy(rows, (a: any) => toolName(String(a.type))).map(([k, v]) => [k, v.length] as const);
  const groups = groupBy(rows, (a: any) => a.callId ?? "—");
  return (
    <>
      <AutoRefresh />
      <header className="p-head">
        <div><h1>Actions</h1><span className="eyebrow">{rows.length} sent from {groups.length} sessions, each policy checked</span></div>
        <div className="pills">{status.map(([k, n]) => <span key={k} className={`pill ${tone(k)}`}>{n} {k.replace(/_/g, " ")}</span>)}</div>
      </header>
      <section className="p-kpis" style={{ gridTemplateColumns: `repeat(${Math.max(1, byTool.length)},minmax(0,1fr))` }}>
        {byTool.map(([k, n]) => <div key={k} className="p-kpi"><span className="eyebrow">{k}</span><b>{n}</b></div>)}
      </section>
      {groups.map(([id, acts]) => {
        const s = meta.get(id);
        return (
          <section key={id} className="p-card p-flush">
            <div className="p-card-h mx-pad">
              <h2>{id === "—" ? "No session" : <Link href={`/sessions/${encodeURIComponent(id)}?tab=events`}>{s?.title ?? id}</Link>}</h2>
              <span className="muted small">{s?.category ? `${s.category} · ` : ""}{acts.length} action{acts.length === 1 ? "" : "s"}</span>
            </div>
            <table className="p-table">
              <thead><tr><th>Tool</th><th>What</th><th>Asked by</th><th>Policy</th><th className="num">Tries</th><th>Status</th><th>Result</th><th>Created</th></tr></thead>
              <tbody>
                {acts.map((a: any) => (
                  <tr key={a._id}>
                    <td><span className="kind">{toolName(String(a.type))}</span></td>
                    <td className="p-wide">{describeAction(a)}</td>
                    <td>{a.requestedBy ?? "—"}</td>
                    <td className="small">{a.policyCheck ? <span className={a.policyCheck.allowed ? "ok" : "badtxt"}>{a.policyCheck.reason}</span> : "—"}</td>
                    <td className="num">{a.attempts ?? 0}</td>
                    <td><span className={`pill ${tone(a.status)}`}>{a.status}</span></td>
                    <td>{a.externalUrl ? <a href={a.externalUrl} target="_blank" rel="noreferrer">{a.externalId ?? "open"}</a> : <span className="muted small">{a.lastError ?? "—"}</span>}</td>
                    <td className="small muted">{when(a.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
      {!rows.length && <section className="p-card"><div className="p-empty">No actions yet. Locked decisions are sent to the tools you connect.</div></section>}
    </>
  );
}
