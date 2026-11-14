"use client";
/** Platform sidebar: search, company nav, live sessions under Sessions, the database hierarchy under Database. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import GomonAvatar from "@/components/GomonAvatar";
import { DB_GROUPS } from "@/lib/dbmap";

const I = (d: string) => <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>;
const ICON = {
  mission: I("M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"),
  sessions: I("M2.5 4h11M2.5 8h11M2.5 12h7"),
  workflows: I("M2.5 3.5h3v3h-3zM10.5 9.5h3v3h-3zM5.5 5h3a1.5 1.5 0 0 1 1.5 1.5v3"),
  database: I("M8 2c3 0 5.5 1 5.5 2.3v7.4C13.5 13 11 14 8 14s-5.5-1-5.5-2.3V4.3C2.5 3 5 2 8 2zM2.5 4.3C2.5 5.6 5 6.6 8 6.6s5.5-1 5.5-2.3M2.5 8c0 1.3 2.5 2.3 5.5 2.3s5.5-1 5.5-2.3"),
  models: I("M5.5 6v4M8 4v8M10.5 6.5v3M3 7.5v1M13 7.5v1"),
  start: I("M8 2.5v11M2.5 8h11"),
  projects: I("M2 3.5h4l1.5 1.5H14v7.5H2z"),
  chev: <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><path d="m6 4 4 4-4 4" /></svg>,
};

export default function Sidebar({ team, live }: { team: string; live: { id: string; title: string }[] }) {
  const path = usePathname();
  const on = (h: string) => (h === "/" ? path === "/" : path === h || path.startsWith(h + "/"));
  const [dbOpen, setDbOpen] = useState(path.startsWith("/database") || path.startsWith("/memory"));
  const [group, setGroup] = useState<string | null>(DB_GROUPS.find((g) => g.colls.some((c) => path === `/database/${c}`))?.group ?? null);
  const item = (href: string, label: string, icon: React.ReactNode, extra?: React.ReactNode) => (
    <Link href={href} className="p-nav" aria-current={on(href) ? "page" : undefined}>{icon}{label}{extra}</Link>
  );
  return (
    <aside className="p-side">
      <Link href="/" className="p-brand"><GomonAvatar size={28} label="" /><span>Gomon</span></Link>
      <form action="/sessions" className="p-search" role="search">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
        <input name="q" placeholder="Search sessions" aria-label="Search sessions" />
      </form>
      <nav>
        <div className="p-navgroup">
          {item("/", "Mission control", ICON.mission)}
          {item("/start", "Start meeting", ICON.start)}
          {item("/sessions", "Sessions", ICON.sessions, live.length ? <span className="p-badge">{live.length}</span> : null)}
          {live.slice(0, 6).map((s) => (
            <Link key={s.id} href={`/sessions/${encodeURIComponent(s.id)}`} className="p-sub" aria-current={path === `/sessions/${encodeURIComponent(s.id)}` || path === `/sessions/${s.id}` ? "page" : undefined}><span className="p-subdot" />{s.title}</Link>
          ))}
          {item("/projects", "Projects", ICON.projects)}
          {item("/workflows", "Workflows", ICON.workflows)}
        </div>
        <div className="p-navgroup">
          <span className="eyebrow">Setup</span>
          {item("/system", "Integrations", ICON.models)}
          <button className="p-nav p-navbtn" aria-expanded={dbOpen} aria-current={on("/database") || on("/memory") ? "page" : undefined} onClick={() => setDbOpen(!dbOpen)}>
            {ICON.database}Database<span className={`p-chev ${dbOpen ? "open" : ""}`}>{ICON.chev}</span>
          </button>
          {dbOpen && (
            <div className="p-tree">
              <Link href="/database" className="p-sub" aria-current={path === "/database" ? "page" : undefined}>All collections</Link>
              {DB_GROUPS.map((g) => (
                <div key={g.group}>
                  <button className="p-sub p-subbtn" aria-expanded={group === g.group} onClick={() => setGroup(group === g.group ? null : g.group)}>
                    <span className={`p-chev ${group === g.group ? "open" : ""}`}>{ICON.chev}</span>{g.group}
                  </button>
                  {group === g.group && g.colls.map((c) => <Link key={c} href={`/database/${c}`} className="p-sub p-leaf" aria-current={path === `/database/${c}` ? "page" : undefined}>{c}</Link>)}
                </div>
              ))}
            </div>
          )}
        </div>
      </nav>
      <div className="p-sidefoot">
        <span className="live-dot" data-muted={live.length ? undefined : "1"} />
        <div><b>{team}</b><span className="muted small">{live.length ? `${live.length} live` : "No live sessions"}</span></div>
      </div>
    </aside>
  );
}
