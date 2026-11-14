import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import { sessions } from "@/lib/platform";
import { dur, when, initials } from "@/lib/format";
export const dynamic = "force-dynamic";

export default async function Sessions({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? "").trim().toLowerCase();
  const all = await sessions();
  const rows = q ? all.filter((r) => [r.title, r.id, ...r.participants].join(" ").toLowerCase().includes(q)) : all;
  const total = rows.reduce((a, r) => a + (r.durationMs ?? 0), 0);
  return (
    <>
      <AutoRefresh />
      <header className="p-head">
        <div><h1>Sessions</h1><span className="eyebrow">{q ? `${rows.length} of ${all.length} match “${q}”` : `${rows.length} sessions · ${dur(total)} recorded`}</span></div>
      </header>
      <section className="p-card p-flush">
        <table className="p-table">
          <thead><tr><th>Session</th><th>Type</th><th>In the meeting</th><th>Started</th><th>Length</th><th className="num">Heard</th><th className="num">Items</th><th className="num">Locked</th><th className="num">Gomon said</th><th className="num">Actions</th><th>Voice</th><th>State</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td><Link href={`/sessions/${encodeURIComponent(s.id)}`} className="p-rowlink">{s.title}</Link><span className="muted small p-id">{s.id}</span></td>
                <td>{s.category}</td>
                <td><span className="p-faces">{s.participants.slice(0, 4).map((p) => <i key={p} title={p}>{initials(p)}</i>)}</span> <span className="small">{s.team.join(", ")}</span>{s.guests.length > 0 && <span className="small muted"> + {s.guests.join(", ")} (guest{s.guests.length > 1 ? "s" : ""})</span>}</td>
                <td>{when(s.startedAt)}</td><td className="mono">{dur(s.durationMs)}</td>
                <td className="num">{s.utterances}</td><td className="num">{s.items}</td><td className="num">{s.locked}</td><td className="num">{s.says}</td><td className="num">{s.actions}</td>
                <td className="small">{s.voice ? "bot joined" : "typed"}</td>
                <td><span className={`pill ${s.state === "live" ? "good" : s.state === "failed" ? "bad" : ""}`}>{s.state}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="p-empty">No sessions yet. Start a call with the bot.</div>}
      </section>
    </>
  );
}
