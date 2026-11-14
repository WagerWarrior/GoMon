import Link from "next/link";
import { notFound } from "next/navigation";
import { HBars } from "@/components/platform/Charts";
import { activity, session, sessions } from "@/lib/platform";
import { mission } from "@/lib/mission";
import { workflowRuns } from "@/lib/workflows";
import { buildTimeline } from "@/lib/timeline";
import SessionChat from "@/components/platform/SessionChat";
import FlowDiagram from "@/components/platform/FlowDiagram";
import { CategoryPicker, ModePicker } from "@/components/platform/SessionBar";
import { templates } from "@/lib/templates";
import AutoRefresh from "@/components/platform/AutoRefresh";
import RecapCard from "@/components/platform/RecapCard";
import Listen from "@/components/platform/Listen";
import EndMeeting from "@/components/platform/EndMeeting";
import Workspace from "@/components/Workspace";
import { recapOf } from "@/lib/recap";
import { bursts, collapse } from "@/lib/group";
import { clock, dur, when } from "@/lib/format";
export const dynamic = "force-dynamic";

/** One session, two views: Live (the chat, with Gomon's reasoning beside it) and Activity (everything it did, bundled). */
export default async function SessionPage({ params, searchParams }: { params: Promise<{ callId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { callId: raw } = await params; const callId = decodeURIComponent(raw);
  const asked = (await searchParams).tab ?? "live";
  const tab = asked === "board" ? "board" : ["activity", "events", "decisions", "timings"].includes(asked) ? "activity" : "live";
  const [s, list, m, tpl] = await Promise.all([session(callId), sessions(), mission(callId), templates()]);
  const meta = list.find((x) => x.id === callId);
  if (!s.call) notFound();
  const ended = s.call.status === "ended";
  const rv = ended ? await recapOf(callId, s.call) : null;
  const href = (t: string) => `/sessions/${encodeURIComponent(callId)}?tab=${t}`;
  return (
    <div className={`ss ${tab === "live" ? "ss-live" : ""}`}>
      <header className="ss-bar">
        <Link href="/sessions" className="ss-back" aria-label="All sessions">←</Link>
        <div className="ss-name">
          <h1>{s.call.title || "Design call"}</h1>
          <span className="ss-meta"><span className={`ss-state s-${meta?.state ?? "ended"}`}><i />{meta?.state === "live" ? "Live" : meta?.state === "failed" ? "Failed" : "Ended"}</span>{when(s.call.startedAt)} · {dur(s.row?.durationMs)} · {[...(meta?.team ?? s.row?.participants ?? [])].join(", ")}{(meta?.guests ?? []).length ? ` + ${meta!.guests.join(", ")} (guest)` : ""}</span>
        </div>
        <ModePicker callId={callId} current={s.call.templateId ?? "design-review"} options={tpl.rows.map((t: any) => ({ id: t._id, name: t.name }))} />
        <CategoryPicker callId={callId} current={meta?.category ?? "Design review"} />
        {!ended && <Listen callId={callId} defaultMe="Robert Reder" defaultRemote="Max Naidenov" />}
        {!ended && <EndMeeting callId={callId} />}
        <nav className="ss-tabs"><Link href={href("live")} aria-current={tab === "live" ? "page" : undefined}>Live</Link><Link href={href("board")} aria-current={tab === "board" ? "page" : undefined}>Board</Link><Link href={href("activity")} aria-current={tab === "activity" ? "page" : undefined}>Activity</Link></nav>
      </header>
      {tab === "live" && rv?.recap && <RecapCard v={rv} ended strip />}
      {tab === "live"
        ? <SessionChat callId={callId} initialEntries={buildTimeline(s).slice(-400)} initialOps={m.ops} initialContext={m.context} />
        : tab === "board"
          // Shared board: architecture diagram from active decisions, live items/conflicts/actions (SSE from Atlas).
          ? <Workspace callId={callId} />
          : <>{rv && <RecapCard v={rv} ended />}<SessionActivity callId={callId} s={s} /></>}
    </div>
  );
}

async function SessionActivity({ callId, s }: { callId: string; s: any }) {
  const [log, wf] = await Promise.all([activity(400, callId), workflowRuns()]);
  const mine = wf.runs.filter((r: any) => r.callId === callId);
  const groups = bursts(s.runs, (x: any) => x.at, 60_000).reverse();
  const folded = collapse(log, (a) => a.kind);
  const locked = s.items.filter((i: any) => i.status === "promoted").length;
  return (
    <>
      <AutoRefresh ms={8000} />
      <section className="p-kpis p-kpis-5">
        <div className="p-kpi"><span className="eyebrow">Heard</span><b>{s.utterances.length}</b></div>
        <div className="p-kpi"><span className="eyebrow">Items saved</span><b>{s.items.length}</b></div>
        <div className="p-kpi"><span className="eyebrow">Locked</span><b>{locked}</b></div>
        <div className="p-kpi"><span className="eyebrow">Gomon said</span><b>{s.says.length}</b></div>
        <div className="p-kpi"><span className="eyebrow">Agent runs</span><b>{s.runs.length}</b></div>
      </section>
      <section className="p-card">
        <div className="p-card-h"><h2>Where decisions went</h2><Link href="/workflows" className="p-more">Workflows</Link></div>
        <FlowDiagram runs={mine} />
      </section>
      <section className="p-row p-row-1-1">
        <div className="p-card">
          <div className="p-card-h"><h2>Decisions</h2><span className="muted small">{locked} locked</span></div>
          <ul className="ws-list">
            {s.items.map((i: any) => (
              <li key={i._id} data-status={i.status}>
                <div className="row"><span className="kind">{String(i.kind).replace(/_/g, " ")}</span><span className={`pill ${i.status === "promoted" ? "good" : i.status === "rejected" ? "bad" : i.status === "locking" ? "warn" : ""}`}>{i.status === "promoted" ? "locked" : i.status === "rejected" ? "vetoed" : i.status}</span></div>
                <p>{i.text}</p>
              </li>
            ))}
            {s.conflicts.map((c: any) => <li key={c._id}><div className="row"><span className="kind">conflict</span>{c.memoryKey && <span className="mono small">{c.memoryKey}</span>}</div><p>{c.note}</p></li>)}
          </ul>
          {!s.items.length && <div className="p-empty">No decisions yet.</div>}
        </div>
        <div className="p-card">
          <div className="p-card-h"><h2>Tool calls</h2><span className="muted small">{s.runs.length} runs in {groups.length} bundles</span></div>
          <ul className="ev-bundles">
            {groups.slice(0, 10).map((g: any[], i: number) => {
              const hits = g.reduce((n, x) => n + (x.retrievedMemoryIds ?? []).length, 0); const wakes = g.filter((x) => x.wake).length;
              return (
                <li key={i}><details><summary><span className="mono small muted">{clock(g[0].at)}</span><b>{g.length} run{g.length === 1 ? "" : "s"}</b><span className="ev-tools"><span>memory.search · {hits} hits</span><span>llm.analyze ×{g.length}</span>{wakes > 0 && <span className="wake">wake ×{wakes}</span>}</span></summary>
                  <ol className="ev-runs">{g.map((x: any) => <li key={x._id}><span className="mono small muted">{clock(x.at)}</span>{x.wake ? "wake word" : "listening"} · {x.batchSize ?? 1} utt · {(x.retrievedMemoryIds ?? []).length} hits</li>)}</ol></details></li>
              );
            })}
          </ul>
          {!s.runs.length && <div className="p-empty">No agent runs.</div>}
          <div className="p-card-h db-gap"><h2>Latency</h2><span className="muted small">p50 · tick p95</span></div>
          <HBars rows={s.stages.map((x: any) => ({ label: x.stage.replace(/_/g, " "), v: x.p50 ?? 0, tick: x.p95, note: `${x.n}` }))} unit="ms" tickLabel="p95" />
        </div>
      </section>
      <section className="p-card">
        <div className="p-card-h"><h2>Event log</h2><span className="muted small">{log.length} events, repeats folded</span></div>
        <ul className="p-feed">{folded.slice(0, 40).map((f, i) => <li key={i}><time>{clock(f.item.at)}</time><span className={`p-kind ${f.item.tone ?? ""}`}>{f.item.kind}{f.n > 1 && <em className="ev-n"> ×{f.n}</em>}</span><span className="p-feed-t"><b>{f.item.actor}</b> {f.item.text}</span></li>)}</ul>
        {!log.length && <div className="p-empty">No events.</div>}
      </section>
    </>
  );
}
