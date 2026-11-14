import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import { actions } from "@/lib/platform";
import { when } from "@/lib/format";
export const dynamic = "force-dynamic";

const tone = (s: string) => (s === "confirmed" || s === "sent" ? "good" : s === "failed" || s === "denied" ? "bad" : s === "needs_review" ? "warn" : "");

export default async function Actions() {
  const rows = await actions();
  return (
    <>
      <AutoRefresh />
      <header className="p-head"><div><span className="eyebrow">Outbox · policy checked · idempotent</span><h1>Actions</h1></div></header>
      <section className="p-card p-flush">
        <table className="p-table">
          <thead><tr><th>Action</th><th>What</th><th>Asked by</th><th>Policy</th><th className="num">Tries</th><th>Status</th><th>Result</th><th>Created</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a._id}>
                <td><span className="kind">{String(a.type).replace(/_/g, " ")}</span></td>
                <td className="p-wide">{a.payload?.title ?? a.payload?.text ?? "—"}{a.callId && <span className="muted small p-id"><Link href={`/sessions/${encodeURIComponent(a.callId)}`}>{a.callId}</Link></span>}</td>
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
        {!rows.length && <div className="p-empty">No actions yet. Locked decisions can open GitHub issues and Slack posts.</div>}
      </section>
    </>
  );
}
