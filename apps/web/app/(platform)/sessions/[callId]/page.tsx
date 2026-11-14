import Link from "next/link";
import { notFound } from "next/navigation";
import AutoRefresh from "@/components/platform/AutoRefresh";
import Workspace from "@/components/Workspace";
import { HBars } from "@/components/platform/Charts";
import { activity, session, sessions } from "@/lib/platform";
import { mission } from "@/lib/mission";
import { workflowRuns } from "@/lib/workflows";
import SessionLive from "@/components/platform/SessionLive";
import FlowDiagram from "@/components/platform/FlowDiagram";
import { bursts, collapse } from "@/lib/group";
import SessionBar, { CategoryPicker } from "@/components/platform/SessionBar";
import { clock, dur, ms, when, initials } from "@/lib/format";
export const dynamic = "force-dynamic";

export default async function SessionPage({ params, searchParams }: { params: Promise<{ callId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { callId: raw } = await params; const callId = decodeURIComponent(raw);
  const tab = (await searchParams).tab ?? "workspace";
  const [s, list, m] = await Promise.all([session(callId), sessions(), mission(callId)]);
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
        <div className="p-head-r">
          <span className={`pill ${meta?.state === "live" ? "good" : meta?.state === "failed" ? "bad" : ""}`}>{meta?.state ?? s.call.status}</span>
          <CategoryPicker callId={callId} current={meta?.category ?? "Design review"} />
          <dl className="sb-stats">
            <div><dt>Length</dt><dd>{dur(r?.durationMs)}</dd></div>
            <div><dt>Heard</dt><dd>{s.utterances.length}</dd></div>
            <div><dt>Items</dt><dd>{s.items.length}</dd></div>
            <div><dt>Locked</dt><dd>{s.items.filter((i: any) => i.status === "promoted").length}</dd></div>
            <div><dt>Said</dt><dd>{s.says.length}</dd></div>
          </dl>
        </div>
      </header>
      <SessionBar callId={callId} tab={tab} initialOps={m.ops.slice(0, 30)} />

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
          <div className="ws-right">
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

      {tab === "live" && <SessionLive callId={callId} initial={m} />}

      {tab === "govern" && <div className="p-live-ws"><Workspace callId={callId} /></div>}
    </>
  );
}

async function Events({ callId, runs, says, clockRel }: { callId: string; runs: any[]; says: any[]; clockRel: (t: string) => string }) {
  const [log, wf] = await Promise.all([activity(400, callId), workflowRuns()]);
  const mine = wf.runs.filter((r: any) => r.callId === callId);
  // Agent runs come every few seconds: bundle them into bursts (a new bundle after 60 s of quiet).
  const groups = bursts(runs, (x: any) => x.at, 60_000).reverse();
  // The event log, with repeats folded: "agent run x12" instead of twelve rows.
  const folded = collapse(log, (a) => a.kind);
  return (
    <>
      <section className="p-card">
        <div className="p-card-h"><h2>Workflow</h2><Link href="/workflows" className="p-more">All workflows</Link></div>
        <FlowDiagram runs={mine} title={`${mine.length} decision${mine.length === 1 ? "" : "s"} from this session`} />
        {mine.length > 0 && (
          <ul className="ev-decs">
            {mine.map((r: any) => (
              <li key={r.id}>
                <span className="ev-dec"><b className="mono">{r.key ?? ""}</b> {r.title}</span>
                <span className="ev-steps">{r.steps.map((st: any) => <span key={st.key} className={`wf-dot s-${st.state}`} title={`${st.label}: ${st.detail ?? st.state}`}><i />{st.url ? <a href={st.url} target="_blank" rel="noreferrer">{st.label}</a> : st.label}</span>)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="p-row p-row-1-1">
        <div className="p-card">
          <div className="p-card-h"><h2>Tool calls</h2><span className="muted small">{runs.length} agent runs in {groups.length} bundle{groups.length === 1 ? "" : "s"}</span></div>
          <ul className="ev-bundles">
            {groups.slice(0, 12).map((g: any[], i: number) => {
              const hits = g.reduce((n, x) => n + (x.retrievedMemoryIds ?? []).length, 0); const wakes = g.filter((x) => x.wake).length; const batch = g.reduce((n, x) => n + (x.batchSize ?? 1), 0);
              return (
                <li key={i}>
                  <details>
                    <summary><span className="mono small muted">{clockRel(g[0].at)}{g.length > 1 ? ` → ${clockRel(g[g.length - 1].at)}` : ""}</span><b>{g.length} run{g.length === 1 ? "" : "s"}</b>
                      <span className="ev-tools"><span>memory.search ×{g.length} · {hits} hits</span><span>llm.analyze ×{g.length}</span>{wakes > 0 && <span className="wake">wake ×{wakes}</span>}</span>
                      <span className="muted small ev-r">{batch} utterance{batch === 1 ? "" : "s"}</span></summary>
                    <ol className="ev-runs">{g.map((x: any) => <li key={x._id}><span className="mono small muted">{clockRel(x.at)}</span>{x.wake ? "wake word" : "listening"} · {x.batchSize ?? 1} utt · {(x.retrievedMemoryIds ?? []).length} hits{x.memoryEnabled === false ? " · memory off" : ""}</li>)}</ol>
                  </details>
                </li>
              );
            })}
          </ul>
          {groups.length > 12 && <span className="muted small">{groups.length - 12} older bundles not shown.</span>}
          {!runs.length && <div className="p-empty">No agent runs.</div>}
        </div>
        <div className="p-card">
          <div className="p-card-h"><h2>Event log</h2><span className="muted small">{log.length} events · {says.length} spoken</span></div>
          <ul className="p-feed">{folded.slice(0, 60).map((f, i) => <li key={i}><time>{clock(f.item.at)}</time><span className={`p-kind ${f.item.tone ?? ""}`}>{f.item.kind}{f.n > 1 && <em className="ev-n"> ×{f.n}</em>}</span><span className="p-feed-t"><b>{f.item.actor}</b> {f.item.text}</span></li>)}</ul>
          {!log.length && <div className="p-empty">No events.</div>}
        </div>
      </section>
    </>
  );
}
