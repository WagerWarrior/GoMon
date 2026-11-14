import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import { activity, sessions, type ActivityRow } from "@/lib/platform";
import { groupBy } from "@/lib/group";
import { clock, when } from "@/lib/format";
export const dynamic = "force-dynamic";

/** Activity, bundled: one card per session with counts per family and only the events someone would act on. */
const FAMILIES = [
  { key: "gov", label: "Governance", test: (k: string) => !/^said|^agent run|conflict|already decided|create issue|post slack|·/.test(k) },
  { key: "said", label: "Gomon said", test: (k: string) => /^said/.test(k) },
  { key: "runs", label: "Agent runs", test: (k: string) => /^agent run/.test(k) },
  { key: "conf", label: "Conflicts", test: (k: string) => /conflict|already decided/.test(k) },
  { key: "out", label: "Outbox", test: (k: string) => !/^said/.test(k) && /·/.test(k) },
] as const;
const familyOf = (k: string) => FAMILIES.find((f) => f.test(k))?.key ?? "gov";

export default async function Activity({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const f = (await searchParams).f ?? "all";
  const [all, list] = await Promise.all([activity(400), sessions()]);
  const meta = new Map(list.map((s) => [s.id, s]));
  const rows = f === "all" ? all : all.filter((a) => familyOf(a.kind) === f);
  const groups = groupBy(rows, (a) => a.callId ?? "workspace");
  return (
    <>
      <AutoRefresh ms={8000} />
      <header className="p-head">
        <div><h1>Activity</h1><span className="eyebrow">{rows.length} events across {groups.length} sessions</span></div>
        <div className="pills">
          <Link href="/activity" className="chip" aria-pressed={f === "all"}>All</Link>
          {FAMILIES.map((x) => <Link key={x.key} href={`/activity?f=${x.key}`} className="chip" aria-pressed={f === x.key}>{x.label}</Link>)}
        </div>
      </header>
      <section className="ac-grid">
        {groups.map(([id, evs]) => {
          const s = meta.get(id);
          const counts = FAMILIES.map((x) => ({ ...x, n: evs.filter((e) => familyOf(e.kind) === x.key).length })).filter((x) => x.n);
          const notable = evs.filter((e) => familyOf(e.kind) !== "runs").slice(0, 4);
          const quiet = evs.length - notable.length;
          return (
            <article key={id} className="p-card ac-card">
              <div className="ac-h">
                <div>
                  {s?.state === "live" && <span className="mx-dot" />}
                  {id === "workspace" ? <b>Workspace</b> : <Link href={`/sessions/${encodeURIComponent(id)}?tab=events`}><b>{s?.title ?? id}</b></Link>}
                  <span className="muted small">{s?.category ? `${s.category} · ` : ""}{when(evs[0].at)}</span>
                </div>
                <span className="mono small muted">{clock(evs[evs.length - 1].at)}–{clock(evs[0].at)}</span>
              </div>
              <div className="ac-counts">{counts.map((c) => <span key={c.key}><b>{c.n}</b> {c.label.toLowerCase()}</span>)}</div>
              <ul className="ac-list">{notable.map((e: ActivityRow, i) => <li key={i}><span className={`p-kind ${e.tone ?? ""}`}>{e.kind}</span><span className="ac-t"><b>{e.actor}</b> {e.text}</span></li>)}</ul>
              {quiet > 0 && id !== "workspace" && <Link href={`/sessions/${encodeURIComponent(id)}?tab=events`} className="p-more">{quiet} more in the session</Link>}
            </article>
          );
        })}
        {!groups.length && <div className="p-card p-empty">No events.</div>}
      </section>
    </>
  );
}
