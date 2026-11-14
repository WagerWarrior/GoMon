import Link from "next/link";
import { notFound } from "next/navigation";
import AutoRefresh from "@/components/platform/AutoRefresh";
import Workspace from "@/components/Workspace";
import { HBars } from "@/components/platform/Charts";
import { activity, session, sessions } from "@/lib/platform";
import { mission } from "@/lib/mission";
import { workflowRuns } from "@/lib/workflows";
import SessionLive from "@/components/platform/SessionLive";
import { templates } from "@/lib/templates";
import { TemplatePicker } from "@/components/platform/Templates";
import { clock, dur, ms, when, initials } from "@/lib/format";
export const dynamic = "force-dynamic";

const TABS = [["workspace", "Workspace"], ["live", "Live"], ["events", "Workflows & events"], ["transcript", "Transcript"], ["decisions", "Decisions"], ["timings", "Timings"], ["govern", "Govern"]] as const;

export default async function SessionPage({ params, searchParams }: { params: Promise<{ callId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { callId: raw } = await params; const callId = decodeURIComponent(raw);
  const tab = (await searchParams).tab ?? "workspace";
  const [s, tpl, list] = await Promise.all([session(callId), templates(), sessions()]);
  const meta = list.find((x) => x.id === callId);
  if (!s.call) notFound();
  const r = s.row; const href = (t: string) => `/sessions/${encodeURIComponent(callId)}?tab=${t}`;
  const t0 = s.utterances[0]?.startedAt ?? s.call.startedAt;
  const rel = (t: string) => (t && t0 ? `T+${dur(Math.max(0, +new Date(t) - +new Date(t0)))}` : "");
  return (
    <>
      {tab !== "live" && tab !== "govern" && <AutoRefresh ms={6000} />}
      <header className="p-head">
        <div>
          <span className="eyebrow"><Link href="/sessions">Sessions</Link> / {meta?.category ?? "Session"} · {callId}</span>
          <h1>{s.call.title || "Design call"}</h1>
          <div className="p-people">{(meta?.team ?? r?.participants ?? []).map((p: string) => <span key={p} className="p-person"><i>{initials(p)}</i>{p}</span>)}{(meta?.guests ?? []).map((p: string) => <span key={p} className="p-person guest" title="Not a team member"><i>{initials(p)}</i>{p}<em>guest</em></span>)}</div>
        </div>
        <div className="p-head-r"><TemplatePicker callId={callId} current={s.call.templateId ?? "design-review"} options={tpl.rows.map((t: any) => ({ id: t._id, name: t.name }))} /><span className={`pill ${meta?.state === "live" ? "good" : meta?.state === "failed" ? "bad" : ""}`}>{meta?.state ?? s.call.status}</span><span className="muted small">{when(s.call.startedAt)}</span></div>
      </header>
      <section className="p-kpis p-kpis-5">
        <div className="p-kpi"><span className="eyebrow">Length</span><b>{dur(r?.durationMs)}</b></div>
        <div className="p-kpi"><span className="eyebrow">Heard</span><b>{s.utterances.length}</b></div>
        <div className="p-kpi"><span className="eyebrow">Items</span><b>{s.items.length}</b></div>
        <div className="p-kpi"><span className="eyebrow">Locked</span><b>{s.items.filter((i: any) => i.status === "promoted").length}</b></div>
        <div className="p-kpi"><span className="eyebrow">Gomon said</span><b>{s.says.length}</b></div>
      </section>
      <nav className="p-tabs">{TABS.map(([k, l]) => <Link key={k} href={href(k)} aria-current={tab === k ? "page" : undefined}>{l}</Link>)}</nav>

      {tab === "workspace" && (
        <section className="ws">
          <div className="p-card ws-col">
            <div className="p-card-h"><h2>Transcript</h2><span className="muted small">{s.utterances.length} turns</span></div>
            <ol className="ws-transcript">
              {s.utterances.map((u: any) => (
                <li key={u._id} data-gomon={u.speaker?.displayName === "Gomon" ? "1" : undefined} data-op={u.speaker?.displayName === "Mission control" ? "1" : undefined}>
                  <div><b>{u.speaker?.displayName ?? "?"}</b><time>{rel(u.startedAt ?? u.receivedAt)}</time></div><p>{u.text}</p>
                </li>
              ))}
            </ol>
            {!s.utterances.length && <div className="p-empty">Nothing heard yet.</div>}
          </div>
          <div className="ws-mid">
            <div className="p-card">
              <div className="p-card-h"><h2>Decisions</h2><span className="muted small">{s.items.filter((i: any) => i.status === "promoted").length} locked</span></div>
              <ul className="ws-list">
                {[...s.items].sort((a: any, b: any) => (a.status === "promoted" ? -1 : 0) - (b.status === "promoted" ? -1 : 0)).map((i: any) => (
                  <li key={i._id} data-status={i.status}>
                    <div className="row"><span className="kind">{String(i.kind).replace(/_/g, " ")}</span><span className={`pill ${i.status === "promoted" ? "good" : i.status === "rejected" ? "bad" : i.status === "locking" ? "warn" : ""}`}>{i.status === "promoted" ? "locked" : i.status === "rejected" ? "vetoed" : i.status}</span></div>
                    <p>{i.text}</p>
                  </li>
                ))}
              </ul>
              {!s.items.length && <div className="p-empty">No decisions yet.</div>}
            </div>
            {s.conflicts.length > 0 && (
              <div className="p-card">
                <div className="p-card-h"><h2>Viewpoints in conflict</h2></div>
                <ul className="ws-list">{s.conflicts.map((c: any) => <li key={c._id}><div className="row"><span className="kind">{c.kind === "already_decided" ? "already decided" : "conflict"}</span>{c.memoryKey && <span className="mono small">{c.memoryKey}</span>}</div><p>{c.note}</p></li>)}</ul>
              </div>
            )}
          </div>
          <div className="ws-side">
            <div className="p-card">
              <div className="p-card-h"><h2>Links</h2></div>
              <ul className="ws-links">
                {s.links.map((l: any, i: number) => (
                  <li key={i}><span className={`ws-tag t-${l.kind}`}>{l.kind}</span>{l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.label}</a> : <span className="mono small">{l.label}</span>}{l.status && <span className="muted small"> · {l.status}</span>}</li>
                ))}
              </ul>
              {!s.links.length && <div className="p-empty">No tickets, threads or docs yet.</div>}
            </div>
            <div className="p-card">
              <div className="p-card-h"><h2>Agent notes</h2><span className="muted small">what Gomon said</span></div>
              <ul className="ws-notes">{s.says.map((x: any) => <li key={x._id}><span className="eyebrow">{(x.reason ?? "say").replace(/_/g, " ")} · {rel(x.createdAt)}</span><p>{x.text}</p></li>)}</ul>
              {!s.says.length && <div className="p-empty">Gomon has not spoken.</div>}
            </div>
          </div>
        </section>
      )}

      {tab === "transcript" && (
        <section className="p-card">
          <ol className="p-transcript">
            {s.utterances.map((u: any) => (
              <li key={u._id} data-gomon={u.speaker?.displayName === "Gomon" ? "1" : undefined}>
                <time>{rel(u.startedAt)}</time><b>{u.speaker?.displayName ?? "?"}</b><p>{u.text}</p>
              </li>
            ))}
          </ol>
          {!s.utterances.length && <div className="p-empty">Nothing heard yet.</div>}
        </section>
      )}

      {tab === "decisions" && (
        <section className="p-row p-row-2-1">
          <div className="p-card">
            <div className="p-card-h"><h2>Items from this session</h2></div>
            <ul className="p-items">
              {s.items.map((i: any) => (
                <li key={i._id} data-status={i.status}>
                  <span className="kind">{String(i.kind).replace(/_/g, " ")}</span>
                  <p>{i.text}</p>
                  <span className={`pill ${i.status === "promoted" ? "good" : i.status === "rejected" ? "bad" : i.status === "locking" ? "warn" : ""}`}>{i.status === "promoted" ? "locked" : i.status === "rejected" ? "vetoed" : i.status}</span>
                </li>
              ))}
            </ul>
            {!s.items.length && <div className="p-empty">No items extracted.</div>}
          </div>
          <div className="p-card">
            <div className="p-card-h"><h2>Conflicts raised</h2></div>
            <ul className="p-items">
              {s.conflicts.map((c: any) => <li key={c._id}><span className="kind">{c.kind === "already_decided" ? "already decided" : "conflict"} {c.memoryKey ?? ""}</span><p>{c.note}</p></li>)}
            </ul>
            {!s.conflicts.length && <div className="p-empty">No conflicts.</div>}
          </div>
        </section>
      )}

      {tab === "timings" && (
        <section className="p-card">
          <div className="p-card-h"><h2>Stage latency</h2><span className="muted small">p50, tick = p95</span></div>
          <HBars rows={s.stages.map((x: any) => ({ label: x.stage.replace(/_/g, " "), v: x.p50 ?? 0, tick: x.p95, note: `${x.n} runs` }))} unit="ms" tickLabel="p95" />
        </section>
      )}

      {tab === "events" && <Events callId={callId} runs={s.runs} says={s.says} clockRel={rel} />}

      {tab === "live" && <SessionLive callId={callId} initial={await mission(callId)} />}

      {tab === "govern" && <div className="p-live-ws"><Workspace callId={callId} /></div>}
    </>
  );
}

async function Events({ callId, runs, says, clockRel }: { callId: string; runs: any[]; says: any[]; clockRel: (t: string) => string }) {
  const [log, wf] = await Promise.all([activity(500, callId), workflowRuns()]);
  const mine = wf.runs.filter((r: any) => r.callId === callId);
  return (
    <>
      <section className="p-card">
        <div className="p-card-h"><h2>Workflow runs</h2><Link href="/workflows" className="p-more">All workflows</Link></div>
        {mine.map((r: any) => (
          <div key={r.id} className="ev-run">
            <div className="ev-run-h"><b className="mono">{r.key ?? ""}</b> {r.title}</div>
            <div className="wf-chain">
              {r.steps.map((st: any, i: number) => (
                <span key={st.key} className={`wf-chip ev-${st.state}`}>{i > 0 && <em>→</em>}<i className={`wf-dot s-${st.state}`}><i /></i>{st.url ? <a href={st.url} target="_blank" rel="noreferrer">{st.label}</a> : st.label}{st.detail && <span className="muted small"> · {st.detail}</span>}</span>
              ))}
            </div>
          </div>
        ))}
        {!mine.length && <div className="p-empty">No workflow fired in this session.</div>}
      </section>
      <section className="p-card p-flush">
        <div className="p-card-h mx-pad"><h2>Tool calls</h2><span className="muted small">each agent run and what it used</span></div>
        <table className="p-table">
          <thead><tr><th>At</th><th>Trigger</th><th>Tools</th><th className="num">Batch</th></tr></thead>
          <tbody>{runs.slice().reverse().map((x: any) => (
            <tr key={x._id}><td className="mono">{clockRel(x.at)}</td><td>{x.wake ? <span className="pill good">wake word</span> : "listening"}</td>
              <td><span className="ev-tools"><span>memory.search · {(x.retrievedMemoryIds ?? []).length} hits</span><span>llm.analyze</span>{x.memoryEnabled === false && <span>memory off</span>}</span></td>
              <td className="num">{x.batchSize ?? 1}</td></tr>
          ))}</tbody>
        </table>
        {!runs.length && <div className="p-empty">No agent runs.</div>}
      </section>
      <section className="p-card">
        <div className="p-card-h"><h2>Event log</h2><span className="muted small">{log.length} events · {says.length} lines spoken</span></div>
        <ul className="p-feed">{log.map((a, i) => <li key={i}><time>{clock(a.at)}</time><span className={`p-kind ${a.tone ?? ""}`}>{a.kind}</span><span className="p-feed-t"><b>{a.actor}</b> {a.text}</span></li>)}</ul>
        {!log.length && <div className="p-empty">No events.</div>}
      </section>
    </>
  );
}
