import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import { sessions, type SessionRow } from "@/lib/platform";
import { groupBy } from "@/lib/group";
import { dur, when, initials } from "@/lib/format";
export const dynamic = "force-dynamic";

/** Sessions: live ones first, then the rest by day. One row each; click opens the session's live chat. `?project=` filters. */
export default async function Sessions({ searchParams }: { searchParams: Promise<{ q?: string; project?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().toLowerCase();
  const all = (await sessions()).filter((r) => !sp.project || r.projectId === sp.project);
  const rows = q ? all.filter((r) => [r.title, r.id, r.category, r.project, ...r.participants].join(" ").toLowerCase().includes(q)) : all;
  const live = rows.filter((r) => r.state === "live");
  const days = groupBy(rows.filter((r) => r.state !== "live"), (r) => new Date(r.startedAt ?? r.lastAt ?? 0).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }));
  return (
    <>
      <AutoRefresh />
      <header className="p-head">
        <div><h1>Sessions</h1><span className="eyebrow">{q ? `${rows.length} of ${all.length} match “${q}”` : `${live.length} live · ${rows.length} total`}</span></div>
        <form action="/sessions" className="p-search sx-search" role="search"><input name="q" defaultValue={q} placeholder="Search by title, person or type" aria-label="Search sessions" /></form>
        <div className="p-head-r">{sp.project && <Link href="/sessions" className="p-more">All projects</Link>}<Link href="/start" className="btn blue sm">Start meeting</Link></div>
      </header>
      {live.length > 0 && <List title="Live now" rows={live} />}
      {days.map(([d, rs]) => <List key={d} title={d} rows={rs} />)}
      {!rows.length && <div className="p-card p-empty">No sessions yet. Start a call with the bot.</div>}
    </>
  );
}

function List({ title, rows }: { title: string; rows: SessionRow[] }) {
  return (
    <section className="sx">
      <span className="eyebrow">{title}</span>
      <ul className="sx-list">
        {rows.map((s) => (
          <li key={s.id}>
            <Link href={`/sessions/${encodeURIComponent(s.id)}`} className="sx-row">
              <span className={`sx-dot s-${s.state}`} />
              <span className="sx-main"><b>{s.title}</b><span className="muted small">{s.project} · {s.category}{s.guests.length ? ` · with ${s.guests.join(", ")}` : ""}</span></span>
              <span className="p-faces">{s.participants.slice(0, 4).map((p) => <i key={p} title={p}>{initials(p)}</i>)}</span>
              <span className="sx-stat"><b>{s.locked}</b> locked</span>
              <span className="sx-stat mono">{dur(s.durationMs)}</span>
              <span className="sx-when muted small">{when(s.lastAt ?? s.startedAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
