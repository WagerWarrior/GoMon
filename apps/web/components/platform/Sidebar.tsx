"use client";
/** Platform sidebar: Gomon mark, two nav groups, live team footer. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import GomonAvatar from "@/components/GomonAvatar";

const I = (d: string) => <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>;
const NAV = [
  { group: "", items: [
    { href: "/mission", label: "Mission control", icon: I("M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z") },
    { href: "/", label: "Overview", icon: I("M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v7H9zM2.5 9H7v4.5H2.5zM9 11.5h4.5v2H9z") },
    { href: "/sessions", label: "Sessions", icon: I("M2.5 4h11M2.5 8h11M2.5 12h7") },
    { href: "/workflows", label: "Workflows", icon: I("M2.5 3.5h3v3h-3zM10.5 9.5h3v3h-3zM5.5 5h3a1.5 1.5 0 0 1 1.5 1.5v3") },
  ] },
  { group: "Analyze", items: [
    { href: "/memory", label: "Memory", icon: I("M8 2c3 0 5.5 1 5.5 2.3v7.4C13.5 13 11 14 8 14s-5.5-1-5.5-2.3V4.3C2.5 3 5 2 8 2zM2.5 4.3C2.5 5.6 5 6.6 8 6.6s5.5-1 5.5-2.3") },
    { href: "/activity", label: "Activity", icon: I("M1.5 8.5h3l2-5 3 9 2-4h3") },
    { href: "/actions", label: "Actions", icon: I("M3 8h9M8.5 4.5 12 8l-3.5 3.5") },
  ] },
  { group: "Agent", items: [
    { href: "/templates", label: "Templates", icon: I("M3 2.5h10v11H3zM5.5 5.5h5M5.5 8h5M5.5 10.5h3") },
    { href: "/system", label: "Models & voice", icon: I("M5.5 6v4M8 4v8M10.5 6.5v3M3 7.5v1M13 7.5v1") },
    { href: "/database", label: "Database", icon: I("M2.5 3.5h11v3h-11zM2.5 9.5h11v3h-11zM5 5h.01M5 11h.01") },
    { href: "/gomon", label: "Avatar", icon: I("M8 2c1 0 5 3.5 5 7a5 5 0 0 1-10 0c0-3.5 4-7 5-7z") },
  ] },
];

export default function Sidebar({ team, live }: { team: string; live: number }) {
  const path = usePathname();
  const on = (h: string) => (h === "/" ? path === "/" : path.startsWith(h));
  return (
    <aside className="p-side">
      <Link href="/" className="p-brand"><GomonAvatar size={28} label="" /><span>Gomon</span></Link>
      <form action="/sessions" className="p-search" role="search">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
        <input name="q" placeholder="Search sessions" aria-label="Search sessions" />
        <kbd>/</kbd>
      </form>
      <nav>
        {NAV.map((g) => (
          <div key={g.group} className="p-navgroup">
            {g.group && <span className="eyebrow">{g.group}</span>}
            {g.items.map((i) => <Link key={i.href} href={i.href} className="p-nav" aria-current={on(i.href) ? "page" : undefined}>{i.icon}{i.label}</Link>)}
          </div>
        ))}
      </nav>
      <div className="p-sidefoot">
        <span className="live-dot" data-muted={live ? undefined : "1"} />
        <div><b>{team}</b><span className="muted small">{live ? `${live} live session${live === 1 ? "" : "s"}` : "No live sessions"}</span></div>
      </div>
    </aside>
  );
}
