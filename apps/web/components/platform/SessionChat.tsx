"use client";
/**
 * A session, live, as a group chat. People on the left, Gomon (and you) on the right, Gomon's work inline:
 * thinking, saving a decision, locking, flagging a conflict, sending to a tool. The composer at the bottom prompts Gomon
 * or makes it speak in the call. The right rail is the visual reasoning (last three stages) and what Gomon holds now.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Entry } from "@/lib/timeline";
import type { Op } from "@/lib/mission";
import { Art, STAGES, stageOf, type StageKey } from "./SessionLive";
import { pulse } from "./SessionBar";

const clock = (t: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const ago = (t: string, now: number) => { const s = Math.max(0, Math.round((now - +new Date(t)) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
const initials = (n: string) => n.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const hue = (n: string) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

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
  useEffect(() => { const t = setInterval(() => { setNow(Date.now()); if (!document.hidden) void load(); }, 2000); return () => clearInterval(t); }, [load]);
  useLayoutEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [entries]);

  const p = pulse(ops as any, now);
  const thinking = ops[0] && ["WAKE", "SEARCH", "THINK"].includes(ops[0].verb) && now - +new Date(ops[0].at) < 10_000;
  const flow = useMemo(() => {
    const seen: StageKey[] = []; const at = new Map<StageKey, Op>();
    for (const o of ops) { const k = stageOf(o); if (!seen.includes(k)) { seen.push(k); at.set(k, o); } if (seen.length === 3) break; }
    return seen.map((k) => ({ s: STAGES.find((x) => x.key === k)!, op: at.get(k)! }));
  }, [ops]);

  async function send() {
    if (!text.trim()) return;
    setBusy(true); setNote(null); stick.current = true;
    const r = await fetch("/api/mission/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId, mode, text }) });
    const j = await r.json().catch(() => ({})); setBusy(false);
    if (r.ok) { setText(""); void load(); } else setNote(j.error ?? `Failed (${r.status})`);
  }

  return (
    <section className="ch">
      <div className="ch-main">
        <div className="ch-pulse" data-tone={p.tone}><span className="sb-led" /><b>{p.text}</b>{p.sub && <span className="sb-sub">{p.sub}</span>}</div>
        <div className="ch-scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {entries.map((e, i) => <Row key={e.id} e={e} prev={entries[i - 1]} />)}
          {thinking && <div className="ch-ev think live"><span className="ad-dots"><i /><i /><i /></span>Gomon is {ops[0].verb === "SEARCH" ? "searching memory" : ops[0].verb === "WAKE" ? "waking up" : "thinking"}</div>}
          {!entries.length && <div className="p-empty">Nothing yet. When people talk, it shows up here.</div>}
        </div>
        <div className="ch-compose">
          <div className="sb-modes" role="group" aria-label="Mode">
            <button aria-pressed={mode === "prompt"} onClick={() => setMode("prompt")}>Prompt Gomon</button>
            <button aria-pressed={mode === "say"} onClick={() => setMode("say")}>Say in call</button>
          </div>
          <div className="ch-input">
            <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder={mode === "prompt" ? "Message Gomon in this call" : "Gomon says this out loud"} aria-label="Message" />
            <button className="sb-send" disabled={busy || !text.trim()} onClick={send} aria-label="Send"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg></button>
          </div>
          {note && <span className="badtxt small">{note}</span>}
        </div>
      </div>

      <aside className="ch-side">
        <div className="ch-card">
          <div className="ch-h"><b>Visual reasoning</b><span className="muted small">last 3 steps</span></div>
          <ol className="ch-flow">
            {flow.map(({ s, op }, i) => (
              <li key={s.key} data-on={now - +new Date(op.at) < 8000 ? "1" : undefined}>
                <div className="sl-node ch-node" data-on={now - +new Date(op.at) < 8000 ? "1" : undefined} data-latest={i === 0 ? "1" : undefined}>
                  <Art k={s.key} />
                  <div><b>{s.title}</b><span className="sl-where">{s.where}</span><span className="sl-optext">{op.text}</span><span className="sl-last">{ago(op.at, now)} ago{op.ms != null ? ` · ${op.ms}ms` : ""}</span></div>
                </div>
              </li>
            ))}
          </ol>
          {!flow.length && <div className="p-empty">Waiting for Gomon.</div>}
        </div>
        <div className="ch-card">
          <div className="ch-h"><b>In Gomon&apos;s head</b>{ctx?.lastRun && <span className="muted small">{ctx.lastRun.recalled} recalled</span>}</div>
          <ul className="mc-ctx">{(ctx?.open ?? []).length ? ctx.open.slice(0, 5).map((m: any, i: number) => <li key={i}><span className={`pill ${m.status === "locking" ? "warn" : ""}`}>{m.status}</span> {m.text}</li>) : <li className="muted">No open items.</li>}</ul>
          {(ctx?.recalled ?? []).length > 0 && <><span className="eyebrow">Recalled</span><ul className="mc-ctx">{ctx.recalled.slice(0, 4).map((m: any, i: number) => <li key={i}><b className="mono">{m.key ?? m.kind}</b> {m.text}</li>)}</ul></>}
        </div>
      </aside>
    </section>
  );
}

function Row({ e, prev }: { e: Entry; prev?: Entry }) {
  if (e.kind === "msg") {
    const grouped = prev?.kind === "msg" && prev.who === e.who && +new Date(e.at) - +new Date(prev.at) < 120_000;
    const gomon = e.who === "Gomon";
    return (
      <div className={`ch-msg ${e.side} ${grouped ? "grouped" : ""} ${gomon ? "gomon" : ""}`}>
        {!grouped && e.side === "left" && <i className="ch-av" style={{ background: `hsl(${hue(e.who)} 30% 40%)` }}>{initials(e.who)}</i>}
        {!grouped && gomon && <i className="ch-av g">G</i>}
        <div className="ch-bwrap">
          {!grouped && <span className="ch-who">{e.who}<time>{clock(e.at)}</time>{e.via === "typed" && e.who !== "Mission control" && <em>typed</em>}{gomon && e.status && <em>{e.status}</em>}</span>}
          <p className="ch-bubble">{e.text}</p>
        </div>
      </div>
    );
  }
  if (e.kind === "think") return <div className="ch-ev think"><span className="ch-ico">◌</span>Gomon thought{e.n > 1 ? ` ${e.n}×` : ""} · {e.hits} memor{e.hits === 1 ? "y" : "ies"} recalled{e.wake && <em> · woken by name</em>}<time>{clock(e.at)}</time></div>;
  if (e.kind === "save") return <div className="ch-ev save"><span className="ch-ico">＋</span><span><b>Saved {e.item}</b> {e.text}</span><span className={`pill ${e.status === "locked" ? "good" : e.status === "vetoed" ? "bad" : e.status === "locking" ? "warn" : ""}`}>{e.status}</span><time>{clock(e.at)}</time></div>;
  if (e.kind === "lock") return <div className={`ch-ev ${e.veto ? "veto" : "lock"}`}><span className="ch-ico">{e.veto ? "×" : "✓"}</span><span><b>{e.veto ? "Vetoed" : "Locked"}</b> by {e.who}{e.text ? ` · ${e.text}` : ""}</span><time>{clock(e.at)}</time></div>;
  if (e.kind === "flag") return <div className="ch-ev flag"><span className="ch-ico">!</span><span><b>Conflict</b> {e.text}</span><time>{clock(e.at)}</time></div>;
  return <div className="ch-ev send"><span className="ch-ico">↗</span><span><b>{e.tool}</b> {e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.text || "open"}</a> : e.text}</span><span className={`pill ${e.status === "confirmed" || e.status === "sent" ? "good" : e.status === "failed" ? "bad" : ""}`}>{e.status}</span><time>{clock(e.at)}</time></div>;
}
