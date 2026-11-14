"use client";
/**
 * A session, live, as the main screen: a group chat (people left, Gomon and you right) with Gomon's work inline.
 * Every "Gomon thought" line opens its trace: model, stage latency, the memories it recalled (links into the database)
 * and what it decided. The right panel is the trace for "now": last three steps, latest latency, and the sources.
 * The composer floats over the chat; Prompt / Say in call are pills inside it.
 */
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Entry, Run } from "@/lib/timeline";
import type { Op } from "@/lib/mission";
import GomonAvatar from "@/components/GomonAvatar";
import { Art, STAGES, stageOf, type StageKey } from "./SessionLive";
import { pulse } from "./SessionBar";

const clock = (t: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const ago = (t: string, now: number) => { const s = Math.max(0, Math.round((now - +new Date(t)) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
const initials = (n: string) => n.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const hue = (n: string) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const sec = (ms?: number) => (ms == null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const memLink = (id: string) => `/database/memories?id=${encodeURIComponent(id)}`;
const STAGE_ORDER = ["queue", "retrieve", "analyze"] as const;
const STAGE_LABEL: Record<string, string> = { queue: "Queue", retrieve: "Memory search", analyze: "Model" };

export default function SessionChat({ callId, initialEntries, initialOps, initialContext }: { callId: string; initialEntries: Entry[]; initialOps: Op[]; initialContext: any }) {
  const [entries, setEntries] = useState(initialEntries);
  const [ops, setOps] = useState(initialOps); const [ctx, setCtx] = useState(initialContext);
  const [now, setNow] = useState(Date.now());
  const [mode, setMode] = useState<"prompt" | "say">("prompt");
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const [note, setNote] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null); const stick = useRef(true);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      fetch(`/api/sessions/${encodeURIComponent(callId)}`, { cache: "no-store" }).catch(() => null),
      fetch(`/api/mission?callId=${encodeURIComponent(callId)}`, { cache: "no-store" }).catch(() => null),
    ]);
    if (a?.ok) setEntries((await a.json()).entries ?? []);
    if (b?.ok) { const j = await b.json(); setOps(j.ops ?? []); setCtx(j.context); }
  }, [callId]);
  useEffect(() => { const t = setInterval(() => { setNow(Date.now()); if (!document.hidden) void load(); }, 1500); return () => clearInterval(t); }, [load]);
  useLayoutEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [entries]);

  const p = pulse(ops as any, now);
  const working = ops[0] && ["WAKE", "SEARCH", "THINK"].includes(ops[0].verb) && now - +new Date(ops[0].at) < 10_000;
  const flow = useMemo(() => {
    const seen: StageKey[] = []; const at = new Map<StageKey, Op>();
    for (const o of ops) { const k = stageOf(o); if (!seen.includes(k)) { seen.push(k); at.set(k, o); } if (seen.length === 3) break; }
    return seen.reverse().map((k) => ({ s: STAGES.find((x) => x.key === k)!, op: at.get(k)! }));
  }, [ops]);
  const lastRun = useMemo(() => { for (let i = entries.length - 1; i >= 0; i--) { const e = entries[i]; if (e.kind === "think") return e.runs[e.runs.length - 1]; } return null; }, [entries]);
  const touched = useMemo(() => {
    const n = { utterances: 0, call_items: 0, says: 0, actions: 0, agent_events: 0 };
    for (const e of entries) { if (e.kind === "msg") e.who === "Gomon" ? n.says++ : n.utterances++; else if (e.kind === "save") n.call_items++; else if (e.kind === "send") n.actions++; else if (e.kind === "think") n.agent_events += e.n; }
    return Object.entries(n).filter(([, v]) => v);
  }, [entries]);

  async function send() {
    if (!text.trim()) return;
    setBusy(true); setNote(null); stick.current = true;
    const r = await fetch("/api/mission/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId, mode, text }) });
    const j = await r.json().catch(() => ({})); setBusy(false);
    if (r.ok) { setText(""); setNote(mode === "say" ? "Queued: the bot says it in the meeting." : "Sent: Gomon wakes on it."); void load(); setTimeout(() => setNote(null), 4000); } else setNote(j.error ?? `Failed (${r.status})`);
  }

  return (
    <section className="ch">
      <div className="ch-main">
        <div className="ch-scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {entries.map((e, i) => <Row key={e.id} e={e} prev={entries[i - 1]} />)}
          {working && <div className="ch-ev think live"><span className="ad-dots"><i /><i /><i /></span>Gomon is {ops[0].verb === "SEARCH" ? "searching memory" : ops[0].verb === "WAKE" ? "waking up" : "thinking"}</div>}
          {!entries.length && <div className="p-empty">Nothing yet. When people talk, it shows up here.</div>}
        </div>
        <div className="ch-compose">
          <div className="ch-status" data-tone={p.tone}><span className="sb-led" /><b>{p.text}</b>{note && <span className="ch-note">{note}</span>}</div>
          <div className="ch-input">
            <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder={mode === "prompt" ? "Message Gomon in this meeting…" : "Gomon says this out loud in the meeting…"} aria-label="Message" />
            <div className="ch-tools">
              <button className="ch-pill" aria-pressed={mode === "prompt"} onClick={() => setMode("prompt")}>Prompt</button>
              <button className="ch-pill" aria-pressed={mode === "say"} onClick={() => setMode("say")}>Say in call</button>
              <button className="sb-send" disabled={busy || !text.trim()} onClick={send} aria-label="Send"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg></button>
            </div>
          </div>
        </div>
      </div>

      <aside className="ch-side">
        <div className="tr-sec">
          <span className="eyebrow">Now</span>
          <ol className="tr-flow">
            {flow.map(({ s, op }) => {
              const on = now - +new Date(op.at) < 8000;
              return <li key={s.key} data-on={on ? "1" : undefined}><Art k={s.key} /><b>{s.title}</b><span>{ago(op.at, now)}</span></li>;
            })}
          </ol>
          {!flow.length && <span className="muted small">Waiting for Gomon.</span>}
        </div>
        <div className="tr-sec">
          <div className="tr-h"><span className="eyebrow">Last run</span>{lastRun && <span className="mono small muted">{lastRun.model ?? ""} · {clock(lastRun.at)}</span>}</div>
          {lastRun ? <><Latency r={lastRun} /><span className="small">{lastRun.did}</span></> : <span className="muted small">No runs yet.</span>}
        </div>
        <div className="tr-sec">
          <div className="tr-h"><span className="eyebrow">Sources</span><Link href="/database/memories" className="small muted">memories →</Link></div>
          <ul className="tr-src">
            {(ctx?.recalled ?? []).slice(0, 5).map((m: any) => <li key={m.id}><Link href={memLink(m.id)}><b className="mono">{m.key ?? m.kind}</b><span>{m.text}</span></Link></li>)}
            {!(ctx?.recalled ?? []).length && <li className="muted small">Nothing recalled on the last run.</li>}
          </ul>
        </div>
        <details className="tr-sec tr-ctx">
          <summary><span className="eyebrow">What Gomon sees each run</span><span className="small muted">harness</span></summary>
          <ul>
            <li><b>Trigger</b> every batch of up to 8 new lines is captured quietly; Gomon speaks when called by name (“hey Gomon”, matched by sound). Pick “Silent scribe” above to keep it quiet otherwise.</li>
            <li><b>Context</b> the last 8 turns + the new lines, up to 20 open items, top 6 team memories</li>
            <li><b>Memory search</b> Atlas vector + text, fused, filtered to this team, project and active memories</li>
            <li><b>Model</b> {lastRun?.model ?? "reasoning model"}, JSON out, up to 2,048 tokens</li>
            <li><b>Tools</b> it can save items, flag conflicts, lock or veto, speak, and queue Slack/GitHub sends; each is an Atlas write, sends pass a policy check</li>
          </ul>
        </details>
        <div className="tr-sec">
          <span className="eyebrow">Written to Atlas</span>
          <div className="tr-colls">{touched.map(([k, v]) => <Link key={k} href={`/database/${k}`}><span className="mono">{k}</span><b>{v}</b></Link>)}</div>
          {(ctx?.open ?? []).length > 0 && <span className="small"><b>{ctx.open.length}</b> open item{ctx.open.length === 1 ? "" : "s"} waiting to lock</span>}
        </div>
      </aside>
    </section>
  );
}

function Latency({ r }: { r: Run }) {
  const total = r.ms.total ?? STAGE_ORDER.reduce((a, k) => a + (r.ms[k] ?? 0), 0);
  return (
    <div className="tr-lat">
      <div className="tr-bar">{STAGE_ORDER.map((k) => r.ms[k] ? <i key={k} className={`b-${k}`} style={{ flex: r.ms[k] }} title={`${STAGE_LABEL[k]} ${sec(r.ms[k])}`} /> : null)}</div>
      <div className="tr-legend">{STAGE_ORDER.map((k) => <span key={k}><i className={`b-${k}`} />{STAGE_LABEL[k]} <b>{sec(r.ms[k])}</b></span>)}<span>Total <b>{sec(total)}</b></span></div>
    </div>
  );
}

function Row({ e, prev }: { e: Entry; prev?: Entry }) {
  const [open, setOpen] = useState(false);
  if (e.kind === "msg") {
    const grouped = prev?.kind === "msg" && prev.who === e.who && +new Date(e.at) - +new Date(prev.at) < 120_000;
    const gomon = e.who === "Gomon";
    return (
      <div className={`ch-msg ${e.side} ${grouped ? "grouped" : ""} ${gomon ? "gomon" : ""}`}>
        {!grouped && e.side === "left" && <i className="ch-av" style={{ background: `hsl(${hue(e.who)} 28% 38%)` }}>{initials(e.who)}</i>}
        {!grouped && gomon && <span className="ch-av g"><GomonAvatar size={30} label="" state="speaking" /></span>}
        <div className="ch-bwrap">
          {!grouped && <span className="ch-who">{e.who}<time>{clock(e.at)}</time>{e.via === "typed" && e.who !== "Mission control" && <em>typed</em>}{gomon && e.status && <em>{e.status === "spoken" ? "said in meeting" : e.status}</em>}</span>}
          <p className="ch-bubble">{e.text}</p>
        </div>
      </div>
    );
  }
  if (e.kind === "think") {
    const last = e.runs[e.runs.length - 1]; const keys = [...new Set(e.runs.flatMap((r) => r.keys))];
    return (
      <div className={`ch-think ${open ? "open" : ""}`}>
        <button className="ch-ev think" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="ch-ico">◌</span>Gomon thought{e.n > 1 ? ` ${e.n}×` : ""}{last?.ms.total != null && <> · {sec(last.ms.total)}</>}
          {keys.length > 0 && <> · recalled {keys.slice(0, 3).join(", ")}{keys.length > 3 ? ` +${keys.length - 3}` : ""}</>}
          {e.wake && <em> · called by name</em>}<span className="ch-caret">{open ? "▴" : "▾"}</span>
        </button>
        {open && (
          <ol className="ch-trace">
            {e.runs.slice(-6).map((r, i) => (
              <li key={i}>
                <div className="tr-h"><span className="mono small">{clock(r.at)} · {r.model ?? "model"}</span><span className="small">{r.did}</span></div>
                <Latency r={r} />
                {r.ids.length > 0 && <div className="ch-keys">{r.ids.map((id, j) => <Link key={id} href={memLink(id)} className="mono">{r.keys[j] ?? id.slice(-6)}</Link>)}</div>}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }
  if (e.kind === "save") return <div className="ch-ev save"><span className="ch-ico">＋</span><span><b>Saved {e.item}</b> {e.text}</span><span className={`pill ${e.status === "locked" ? "good" : e.status === "vetoed" ? "bad" : e.status === "locking" ? "warn" : ""}`}>{e.status}</span><time>{clock(e.at)}</time></div>;
  if (e.kind === "lock") return <div className={`ch-ev ${e.veto ? "veto" : "lock"}`}><span className="ch-ico">{e.veto ? "×" : "✓"}</span><span><b>{e.veto ? "Vetoed" : "Locked"}</b> by {e.who}{e.text ? ` · ${e.text}` : ""}</span><time>{clock(e.at)}</time></div>;
  if (e.kind === "flag") return <div className="ch-ev flag"><span className="ch-ico">!</span><span><b>Conflict</b> {e.text}</span><time>{clock(e.at)}</time></div>;
  return <div className="ch-ev send"><span className="ch-ico">↗</span><span><b>{e.tool}</b> {e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.text || "open"}</a> : e.text}</span><span className={`pill ${e.status === "confirmed" || e.status === "sent" ? "good" : e.status === "failed" ? "bad" : ""}`}>{e.status}</span><time>{clock(e.at)}</time></div>;
}
