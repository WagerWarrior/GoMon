import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import { activity, overview } from "@/lib/platform";
import Latest from "@/components/platform/Latest";
import { dur, ms, when } from "@/lib/format";
export const dynamic = "force-dynamic";

/** Mission control: the whole company at a glance. One session's live detail lives on its own page. */
export default async function MissionControlHome() {
  const [o, feed] = await Promise.all([overview(), activity(300)]);
  const k = o.kpi; const r = o.reliability;
  const live = o.sessions.filter((s: any) => s.state === "live");
  const pct = (v: number | null) => (v == null ? "—" : `${v}%`);
  return (
    <>
      <AutoRefresh />
      <header className="p-head">
        <div><h1>Mission control</h1><span className="eyebrow">{k.sessions} sessions · {live.length} live now</span></div>
        <Link href="/start" className="btn blue sm">Start meeting</Link>
      </header>

      <section className="mx-live">
        {live.length ? live.map((s: any) => (
          <Link key={s.id} href={`/sessions/${encodeURIComponent(s.id)}`} className="mx-livecard">
            <div className="row"><span className="mx-dot" />{s.project} · {s.category}<span className="muted small mx-right">{dur(s.durationMs)}</span></div>
            <b>{s.title}</b>
            <span className="muted small">{[...s.team, ...s.guests].join(", ") || "—"}</span>
            <div className="mx-livestats"><span>{s.utterances} heard</span><span>{s.locked} locked</span><span>{s.says} said</span><span className="mx-open">Open live →</span></div>
          </Link>
        )) : <div className="mx-livecard mx-empty">No live sessions. The most recent was {when(o.sessions[0]?.lastAt)}.</div>}
      </section>

      <section className="p-kpis p-kpis-5">
        <Kpi label="Sessions" v={k.sessions} />
        <Kpi label="Utterances heard" v={k.utterances} />
        <Kpi label="Decisions locked" v={k.locked} sub={`${o.vetoed} vetoed`} />
        <Kpi label="Team memory" v={k.memories} />
        <Kpi label="Answer p50" v={ms(k.p50)} />
      </section>

      <section className="p-row p-row-2-1">
        <div className="p-card">
          <div className="p-card-h"><h2>Reliability</h2></div>
          <div className="mx-rel">
            <Rel label="Failed sessions" v={`${r.failed}`} sub={pct(r.failedRate)} bad={r.failed > 0} />
            <Rel label="Bot joined by voice" v={pct(r.botJoinRate)} sub={`${r.botJoined} of ${k.sessions}`} />
            <Rel label="Utterances processed" v={pct(r.pipeline)} />
            <Rel label="Processed within 10 s" v={pct(r.within10s)} />
            <Rel label="Sends delivered" v={pct(r.sends)} sub={`${r.sendsOk} of ${r.sendsTotal}`} />
          </div>
        </div>
        <div className="p-card">
          <div className="p-card-h"><h2>Benchmarks</h2><span className="muted small">against target</span></div>
          <table className="p-table mx-bench"><tbody>
            {r.benchmarks.map((b: any) => (
              <tr key={b.name}><td>{b.name}</td><td className="num">{ms(b.value)}</td><td className="num muted">{ms(b.target)}</td>
                <td><span className={`pill ${b.value == null ? "" : b.value <= b.target ? "good" : "warn"}`}>{b.value == null ? "no data" : b.value <= b.target ? "pass" : "over"}</span></td></tr>
            ))}
          </tbody></table>
        </div>
      </section>

      <section className="p-card">
        <div className="p-card-h"><h2>Latest</h2><span className="muted small">what Gomon just did, across sessions</span></div>
        <Latest rows={feed} sessions={o.sessions} n={6} />
      </section>

      <section className="p-card p-flush">
        <div className="p-card-h mx-pad"><h2>Recent sessions</h2><Link href="/sessions" className="p-more">All sessions</Link></div>
        <table className="p-table">
          <thead><tr><th>Session</th><th>Project</th><th>Type</th><th>People</th><th>Length</th><th className="num">Heard</th><th className="num">Locked</th><th>State</th></tr></thead>
          <tbody>
            {o.sessions.filter((x: any) => x.state !== "live").slice(0, 6).map((s: any) => (
              <tr key={s.id}>
                <td><Link href={`/sessions/${encodeURIComponent(s.id)}`} className="p-rowlink">{s.title}</Link><span className="muted small p-id">{s.id}</span></td>
                <td>{s.project}</td><td>{s.category}</td><td>{[...s.team, ...s.guests].join(", ") || "—"}</td><td className="mono">{dur(s.durationMs)}</td>
                <td className="num">{s.utterances}</td><td className="num">{s.locked}</td><td><State s={s.state} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Kpi({ label, v, sub }: { label: string; v: number | string; sub?: string }) {
  return <div className="p-kpi"><span className="eyebrow">{label}</span><b>{v}</b>{sub && <span className="muted small">{sub}</span>}</div>;
}
function Rel({ label, v, sub, bad }: { label: string; v: string; sub?: string; bad?: boolean }) {
  return <div className="mx-relcell"><span className="eyebrow">{label}</span><b className={bad ? "badtxt" : ""}>{v}</b>{sub && <span className="muted small">{sub}</span>}</div>;
}
function State({ s }: { s: string }) {
  return <span className={`pill ${s === "live" ? "good" : s === "failed" ? "bad" : ""}`}>{s}</span>;
}
