import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import { Funnel, HBars, TimeArea } from "@/components/platform/Charts";
import GomonAvatar from "@/components/GomonAvatar";
import { activity, overview } from "@/lib/platform";
import { dur, ms, when, clock } from "@/lib/format";
import { scope } from "@/lib/db";
export const dynamic = "force-dynamic";

export default async function Overview() {
  const [o, feed] = await Promise.all([overview(), activity(10)]);
  const { projectId } = scope();
  const k = o.kpi;
  const live = o.sessions.find((s: any) => s.status === "live");
  return (
    <>
      <AutoRefresh />
      <header className="p-head">
        <div><span className="eyebrow">{projectId}</span><h1>Overview</h1></div>
        <div className="p-head-r"><span className="p-live"><span className="live-dot" />Atlas live</span>{live && <Link className="btn blue sm" href={`/sessions/${encodeURIComponent(live.id)}?tab=live`}>Open live session</Link>}</div>
      </header>

      <section className="p-kpis">
        <Kpi label="Sessions" v={k.sessions} sub={`${k.live} live now`} />
        <Kpi label="Utterances heard" v={k.utterances} sub="across all sessions" />
        <Kpi label="Decisions locked" v={k.locked} sub={`${o.vetoed} vetoed`} />
        <Kpi label="Team memory" v={k.memories} sub="active and superseded" />
        <Kpi label="Gomon spoke" v={k.says} sub="lines said in calls" />
        <Kpi label="Pipeline p50" v={ms(k.p50)} sub="utterance to item" />
      </section>

      <section className="p-row p-row-2-1">
        <div className="p-card">
          <div className="p-card-h"><h2>Utterances per minute</h2><span className="muted small">last hour with activity</span></div>
          <TimeArea label="utterances" data={o.series.map((b: any) => ({ t: b.t, v: b.n }))} />
        </div>
        <div className="p-card p-gomon">
          <div className="p-card-h"><h2>Gomon</h2><span className="pill good">{live ? "In a call" : "Idle"}</span></div>
          <div className="p-gomon-face"><GomonAvatar state={live ? "listening" : "vetoed"} size={132} /></div>
          <div className="p-gomon-meta">
            <div><span className="eyebrow">Session</span><b>{live?.title ?? "None live"}</b></div>
            <div><span className="eyebrow">With</span><b>{live?.participants.join(", ") || "—"}</b></div>
            <div><span className="eyebrow">Running</span><b>{dur(live?.durationMs)}</b></div>
          </div>
        </div>
      </section>

      <section className="p-row p-row-3">
        <div className="p-card">
          <div className="p-card-h"><h2>Decision funnel</h2></div>
          <Funnel steps={o.funnel} />
        </div>
        <div className="p-card">
          <div className="p-card-h"><h2>Pipeline latency</h2><span className="muted small">p50, tick = p95</span></div>
          <HBars rows={o.stages.map((s: any) => ({ label: s.stage.replace(/_/g, " "), v: s.p50 ?? 0, tick: s.p95, note: `${s.n} runs` }))} unit="ms" tickLabel="p95" />
        </div>
        <div className="p-card">
          <div className="p-card-h"><h2>Memory by kind</h2></div>
          <HBars rows={o.memKinds.map((m: any) => ({ label: m.label.replace(/_/g, " "), v: m.n }))} />
        </div>
      </section>

      <section className="p-row p-row-1-1">
        <div className="p-card">
          <div className="p-card-h"><h2>End-to-end latency</h2><span className="muted small">each agent run, total</span></div>
          <TimeArea label="latency" height={170} data={o.latency.map((l: any) => ({ t: l.at, v: l.ms }))} unit="ms" />
        </div>
        <div className="p-card">
          <div className="p-card-h"><h2>Recent activity</h2><Link href="/activity" className="p-more">All activity</Link></div>
          <ul className="p-feed">
            {feed.map((a, i) => <li key={i}><time>{clock(a.at)}</time><span className={`p-kind ${a.tone ?? ""}`}>{a.kind}</span><span className="p-feed-t"><b>{a.actor}</b> {a.text}</span></li>)}
          </ul>
        </div>
      </section>

      <section className="p-card">
        <div className="p-card-h"><h2>Sessions</h2><Link href="/sessions" className="p-more">All sessions</Link></div>
        <table className="p-table">
          <thead><tr><th>Title</th><th>With</th><th>Started</th><th>Length</th><th className="num">Heard</th><th className="num">Locked</th><th>Status</th></tr></thead>
          <tbody>
            {o.sessions.slice(0, 6).map((s: any) => (
              <tr key={s.id}>
                <td><Link href={`/sessions/${encodeURIComponent(s.id)}`} className="p-rowlink">{s.title}</Link><span className="muted small p-id">{s.id}</span></td>
                <td>{s.participants.join(", ") || "—"}</td><td>{when(s.startedAt)}</td><td>{dur(s.durationMs)}</td>
                <td className="num">{s.utterances}</td><td className="num">{s.locked}</td>
                <td><span className={`pill ${s.status === "live" ? "good" : ""}`}>{s.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Kpi({ label, v, sub }: { label: string; v: number | string; sub: string }) {
  return <div className="p-kpi"><span className="eyebrow">{label}</span><b>{v}</b><span className="muted small">{sub}</span></div>;
}
