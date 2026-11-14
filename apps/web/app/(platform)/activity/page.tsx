import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import { activity } from "@/lib/platform";
import { clock, when } from "@/lib/format";
export const dynamic = "force-dynamic";

const FILTERS = [["all", "All"], ["audit", "Governance"], ["said", "Gomon said"], ["agent run", "Agent runs"], ["conflict", "Conflicts"], ["create issue|post slack", "Outbox"]] as const;

export default async function Activity({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const f = (await searchParams).f ?? "all";
  const all = await activity(400);
  const rows = f === "all" ? all : f === "audit" ? all.filter((a) => !/^said|^agent run|conflict|already decided|create issue|post slack/.test(a.kind)) : all.filter((a) => new RegExp(f === "conflict" ? "conflict|already decided" : f).test(a.kind));
  return (
    <>
      <AutoRefresh />
      <header className="p-head">
        <div><span className="eyebrow">audit_events · says · actions · agent_events · conflicts</span><h1>Activity</h1></div>
        <div className="pills">{FILTERS.map(([k, l]) => <Link key={k} href={`/activity?f=${encodeURIComponent(k)}`} className="chip" aria-pressed={f === k}>{l}</Link>)}</div>
      </header>
      <section className="p-card p-flush">
        <table className="p-table">
          <thead><tr><th>Time</th><th>Event</th><th>Who</th><th>Detail</th><th>Session</th></tr></thead>
          <tbody>
            {rows.map((a, i) => (
              <tr key={i}>
                <td className="mono" title={when(a.at)}>{clock(a.at)}</td>
                <td><span className={`p-kind ${a.tone ?? ""}`}>{a.kind}</span></td>
                <td>{a.actor}</td><td className="p-wide">{a.text}</td>
                <td>{a.callId ? <Link href={`/sessions/${encodeURIComponent(a.callId)}?tab=history`}>{a.callId}</Link> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="p-empty">No events.</div>}
      </section>
    </>
  );
}
