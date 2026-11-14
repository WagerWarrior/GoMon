"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import AskPanel from "./AskPanel";
import Diagram from "./Diagram";
import { buildDiagram } from "@/lib/mermaid";
import { stageStats } from "@/lib/stats";
import type { ActionDoc, AuditEvent, CallDoc, CallItem, Conflict, Member, Memory, TimingDoc, Utterance } from "@/lib/types";

type Data = { calls: CallDoc[]; utterances: Utterance[]; call_items: CallItem[]; memories: Memory[]; conflicts: Conflict[]; actions: ActionDoc[]; audit_events: AuditEvent[]; timings: TimingDoc[]; members: Member[] };
const EMPTY: Data = { calls: [], utterances: [], call_items: [], memories: [], conflicts: [], actions: [], audit_events: [], timings: [], members: [] };
const id = (x: unknown) => String((x as any)?._id ?? x);
const clock = (t?: Date | string) => (t ? new Date(t).toLocaleTimeString([], { hour12: false }) : "");
const KIND: Record<string, string> = { decision: "Decision", requirement: "Requirement", constraint: "Constraint", risk: "Risk", open_question: "Question", action: "Action", assumption: "Assumption", interface: "Interface", alternative: "Alternative" };

export default function Workspace({ callId }: { callId: string }) {
  const [data, setData] = useState<Data>(EMPTY);
  const [live, setLive] = useState<"connecting" | "change-stream" | "polling" | "offline">("connecting");
  const [actor, setActor] = useState("");
  const [toast, setToast] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [history, setHistory] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmForget, setConfirmForget] = useState<string | null>(null);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);
  useEffect(() => {
    const es = new EventSource(`/api/stream?callId=${encodeURIComponent(callId)}`);
    es.addEventListener("snapshot", (e) => setData({ ...EMPTY, ...JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("panel", (e) => { const { panel, docs } = JSON.parse((e as MessageEvent).data); setData((d) => ({ ...d, [panel]: docs })); });
    es.addEventListener("mode", (e) => setLive(JSON.parse((e as MessageEvent).data).mode));
    es.onerror = () => setLive("offline");
    es.onopen = () => setLive((l) => (l === "offline" || l === "connecting" ? "change-stream" : l));
    return () => es.close();
  }, [callId]);
  useEffect(() => { if (!actor && data.members.length) setActor(localStorage.getItem("gomon.actor") || (data.members.find((m) => m.role === "lead") ?? data.members[0]).displayName); }, [data.members, actor]);
  useEffect(() => { if (actor) localStorage.setItem("gomon.actor", actor); }, [actor]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); }, [toast]);

  const call = data.calls[0];
  const memories = data.memories;
  const active = useMemo(() => memories.filter((m) => m.status === "active"), [memories]);
  const lockedFromCall = active.filter((m) => m.origin === "call");
  const byId = useMemo(() => new Map(memories.map((m) => [id(m), m])), [memories]);
  const diagram = useMemo(() => buildDiagram(memories, call?.title ?? "Project"), [memories, call?.title]);
  const stats = useMemo(() => stageStats(data.timings), [data.timings]);
  const role = data.members.find((m) => m.displayName === actor)?.role;

  const gov = useCallback(async (op: string, extra: Record<string, unknown> = {}, okText?: string) => {
    const r = await fetch("/api/gov", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, actor, callId, ...extra }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) setToast({ kind: "ok", text: okText ?? "Done." });
    else setToast({ kind: "bad", text: j.error === "policy_denied" ? `Policy denied: ${j.reason}` : j.error ?? `Failed (${r.status})` });
    return r.ok;
  }, [actor, callId]);

  const conflictFor = (itemId: string) => data.conflicts.filter((c) => id(c.itemId) === itemId);

  return (
    <div className="shell">
      <header className="bar">
        <div><h1>{call?.title ?? "Call"}</h1><div className="muted">{callId} · {call?.synthetic ? <b className="synthetic">SYNTHETIC DATA</b> : call?.status ?? ""}</div></div>
        <div className="bar-r">
          <span className={`pill ${live === "offline" ? "bad" : live === "connecting" ? "" : "good"}`} title="Updates arrive from MongoDB change streams">{live === "offline" ? "Offline" : live === "connecting" ? "Connecting" : live === "polling" ? "Live (polling)" : "Live"}</span>
          <label className="who">Acting as
            <select value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Acting as">
              {data.members.map((m) => <option key={id(m)} value={m.displayName}>{m.displayName} ({m.role})</option>)}
            </select></label>
        </div>
      </header>
      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}

      <main className="grid">
        <section className="card tall"><h2>Transcript <span className="count">{data.utterances.length}</span></h2>
          <ol className="transcript" aria-live="polite">
            {data.utterances.length === 0 && <li className="muted">Waiting for committed transcript segments.</li>}
            {data.utterances.map((u) => <li key={id(u)} className={u.speaker.displayName === "Gomon" ? "gomon" : ""}><b>{u.speaker.displayName}</b><span>{u.text}</span></li>)}
          </ol></section>

        <section className="card tall"><h2>Call items <span className="count">{data.call_items.length}</span></h2>
          <ul className="items">
            {data.call_items.length === 0 && <li className="muted">No items yet. Gomon writes proposals here as the call goes.</li>}
            {data.call_items.map((it) => {
              const iid = id(it), cf = conflictFor(iid);
              const veto = it.status === "locking" && it.lockAnnouncedAt ? Math.max(0, (new Date(it.lockAnnouncedAt).getTime() + (it.vetoMs ?? 10000) - now) / 1000) : null;
              return (<li key={iid} className={`item ${it.status}`}>
                <div className="row"><span className="kind">{KIND[it.kind] ?? it.kind}</span><span className={`pill ${it.status === "promoted" ? "good" : it.status === "rejected" ? "bad" : it.status === "locking" ? "warn" : ""}`}>{it.status}</span></div>
                <p>{it.text}</p>
                {cf.map((c) => <div key={id(c)} className="flag">Conflicts with <b>{c.memoryKey ?? "memory"}</b>{c.note ? `: ${c.note}` : ""} <span className="muted">({c.severity}{c.spoken ? ", spoken" : ""})</span></div>)}
                {veto !== null && <div className="veto"><i style={{ width: `${Math.min(100, (veto / ((it.vetoMs ?? 10000) / 1000)) * 100)}%` }} /><span>{veto > 0 ? `Veto window ${veto.toFixed(0)} s` : "Veto window closed"}</span></div>}
                {(it.status === "proposed" || it.status === "locking") && <div className="btns">
                  <button className="btn blue sm" onClick={() => gov("lock", { id: iid }, "Locked. Now canonical memory.")}>Lock</button>
                  <button className="btn sm" onClick={() => gov("reject", { id: iid }, "Rejected.")}>{it.status === "locking" ? "Veto" : "Reject"}</button></div>}
              </li>);
            })}
          </ul></section>

        <section className="card tall"><h2>Canonical memory <span className="count">{active.length}</span>
          <label className="toggle"><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> history</label></h2>
          <ul className="items">
            {memories.filter((m) => history || m.status === "active").map((m) => {
              const mid = id(m); const prev = m.supersedes ? byId.get(id(m.supersedes)) : null;
              return (<li key={mid} className={`item mem ${m.status}`}>
                <div className="row"><span className="kind">{m.key ?? KIND[m.kind] ?? m.kind}{m.version > 1 ? ` · v${m.version}` : ""}</span>
                  <span className={`pill ${m.status === "active" ? "good" : m.status === "forgotten" ? "bad" : ""}`}>{m.status}</span></div>
                <p className={m.status !== "active" ? "struck" : ""}>{m.text}</p>
                <div className="muted small">{m.origin === "doc" ? "From design docs" : `Locked ${clock(m.lock?.lockedAt)} by ${m.lock?.lockedBy ?? "team"}${m.lock?.participants?.length ? ` · present: ${m.lock.participants.join(", ")}` : ""}`}
                  {prev ? ` · supersedes v${prev.version}` : ""}{m.status === "forgotten" ? ` · forgotten by ${m.forgottenBy}` : ""}</div>
                {m.status === "active" && (editing === mid
                  ? <div className="edit"><textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} aria-label="Corrected text" />
                      <div className="btns"><button className="btn blue sm" onClick={async () => { if (await gov("correct", { id: mid, text: draft }, "Corrected. Old version left retrieval.")) setEditing(null); }}>Save correction</button><button className="btn sm" onClick={() => setEditing(null)}>Cancel</button></div></div>
                  : <div className="btns"><button className="btn sm" onClick={() => { setEditing(mid); setDraft(m.text); }}>Correct</button>
                      {confirmForget === mid ? <><button className="btn red sm" onClick={async () => { await gov("forget", { id: mid }, "Forgotten. History kept."); setConfirmForget(null); }}>Confirm forget</button><button className="btn sm" onClick={() => setConfirmForget(null)}>Cancel</button></>
                        : <button className="btn sm" onClick={() => setConfirmForget(mid)}>Forget</button>}</div>)}
              </li>);
            })}
          </ul></section>

        <section className="card wide"><h2>Conflicts <span className="count">{data.conflicts.length}</span></h2>
          {data.conflicts.length === 0 ? <p className="muted">No conflicts with stored memory so far.</p> :
            <ul className="plain">{data.conflicts.map((c) => <li key={id(c)}><span className={`pill ${c.severity === "high" ? "bad" : "warn"}`}>{c.severity}</span> <b>{c.memoryKey ?? "memory"}</b> {c.note} {c.spoken ? <span className="muted">· Gomon said this aloud</span> : null}</li>)}</ul>}</section>

        <AskPanel callId={callId} actor={actor} />
        <section className="card wide"><h2>Decision diagram <span className="muted small">generated from active memories</span></h2><Diagram source={diagram} /></section>

        <section className="card wide"><h2>Actions &amp; audit</h2>
          <div className="btns top">
            <button className="btn blue sm" disabled={!lockedFromCall.length} onClick={() => gov("create_issue", {}, "Queued GitHub issues. The connector will check policy and send.")}>Create tickets</button>
            <button className="btn sm" disabled={!lockedFromCall.length} onClick={() => gov("post_slack", {}, "Queued Slack post. The connector will check policy and send.")}>Post to Slack</button>
            <span className="muted small">{lockedFromCall.length ? `${lockedFromCall.length} locked decision${lockedFromCall.length > 1 ? "s" : ""} from this call` : "Lock a decision first"} · requester: {actor || "—"}{role ? ` (${role})` : ""}</span></div>
          <table className="tbl"><thead><tr><th>Action</th><th>Status</th><th>Requested by</th><th>Policy</th><th>External</th></tr></thead>
            <tbody>{data.actions.length === 0 && <tr><td colSpan={5} className="muted">Nothing requested yet.</td></tr>}
              {data.actions.map((a) => (<tr key={id(a)}><td>{a.type === "create_issue" ? "GitHub issue" : "Slack post"}<div className="muted small">{String((a.payload as any)?.title ?? (a.payload as any)?.text ?? "").slice(0, 70)}</div></td>
                <td><span className={`pill ${a.status === "sent" || a.status === "confirmed" ? "good" : a.status === "denied" || a.status === "failed" ? "bad" : "warn"}`}>{a.status}</span>{a.error ? <div className="muted small">{a.error}</div> : null}</td>
                <td>{a.requestedBy}</td>
                <td>{a.policyCheck ? <span className={a.policyCheck.allowed ? "ok" : "badtxt"}>{a.policyCheck.allowed ? "allowed" : "denied"}</span> : <span className="muted">pending</span>}<div className="muted small">{a.policyCheck?.reason}</div></td>
                <td>{a.externalUrl ? <a href={a.externalUrl} target="_blank" rel="noreferrer">{a.externalId}</a> : a.externalId ?? <span className="muted">not sent</span>}</td></tr>))}</tbody></table>
          <h3>Audit trail</h3>
          <ul className="audit">{data.audit_events.length === 0 && <li className="muted">Nothing yet.</li>}
            {data.audit_events.map((e) => <li key={id(e)}><time>{clock(e.at)}</time><b className={/denied/.test(e.type) ? "badtxt" : ""}>{e.type.replace(/_/g, " ")}</b><span>{e.actor}</span><span className="muted">{e.reason}</span></li>)}</ul></section>

        <section className="card wide"><h2>Timings</h2>
          {stats.length === 0 ? <p className="muted">No timings logged yet. Targets in the spec are unmeasured until the worker writes them.</p> :
            <table className="tbl"><thead><tr><th>Stage</th><th>n</th><th>p50</th><th>p95</th></tr></thead><tbody>{stats.map((s) => <tr key={s.stage}><td>{s.stage}</td><td>{s.n}</td><td>{s.p50} ms</td><td>{s.p95} ms</td></tr>)}</tbody></table>}</section>
      </main>
      <footer className="foot">Synthetic company context. Memory is team-scoped and governed; every change is audited in MongoDB.</footer>
    </div>
  );
}
