"use client";
/**
 * Mission control: the whole Gomon system on one canvas (Railway-style), driven by real Atlas writes.
 * Nodes light up when an op touches them, edges animate with width by traffic, the reasoning stream names each op
 * (LISTEN, SEARCH, THINK, APPEND, LOCK, SPEAK, SEND), and the operator can prompt Gomon or make it speak.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import GomonAvatar from "@/components/GomonAvatar";
import type { GomonStateKey } from "@/lib/gomon/states";
import type { EdgeId, NodeId, Op, Verb } from "@/lib/mission";

type Data = { now: string; callId: string | null; calls: any[]; ops: Op[]; context: any };

const NODES: Record<NodeId, { x: number; y: number; title: string; sub: string; kind: string }> = {
  operator: { x: 120, y: 64, title: "Mission control", sub: "you · prompts, says", kind: "Operator" },
  call: { x: 120, y: 240, title: "Meeting", sub: "Recall bot · voice in", kind: "Voice" },
  utt: { x: 345, y: 240, title: "utterances", sub: "Atlas · change stream", kind: "Collection" },
  worker: { x: 570, y: 240, title: "Reasoning", sub: "worker · LLM", kind: "Agent" },
  mem: { x: 570, y: 64, title: "memories", sub: "vector + text search", kind: "Collection" },
  items: { x: 795, y: 240, title: "call_items", sub: "scratch, 6 h TTL", kind: "Collection" },
  gov: { x: 1020, y: 150, title: "Governance", sub: "lock · veto · policy", kind: "Rules" },
  says: { x: 570, y: 410, title: "says", sub: "ElevenLabs · voice out", kind: "Collection" },
  outbox: { x: 1020, y: 350, title: "Outbox", sub: "Slack · GitHub", kind: "Connectors" },
};
const EDGES: Record<EdgeId, { a: NodeId; b: NodeId; bend?: number }> = {
  "op-utt": { a: "operator", b: "utt", bend: 0 }, "op-says": { a: "operator", b: "says", bend: -150 },
  "call-utt": { a: "call", b: "utt" }, "utt-worker": { a: "utt", b: "worker" }, "worker-mem": { a: "worker", b: "mem" },
  "worker-items": { a: "worker", b: "items" }, "worker-says": { a: "worker", b: "says" }, "items-gov": { a: "items", b: "gov" },
  "gov-mem": { a: "gov", b: "mem", bend: -40 }, "gov-outbox": { a: "gov", b: "outbox" }, "says-call": { a: "says", b: "call", bend: 60 },
};
const VERB_FACE: Partial<Record<Verb, GomonStateKey>> = { SEARCH: "recalling", THINK: "recalling", LOCK: "locked", VETO: "vetoed", SPEAK: "speaking", OPERATOR: "speaking", SEND: "acting", APPEND: "listening", LISTEN: "listening", WAKE: "recalling", FLAG: "recalling" };
const W = 150, H = 64; // node card half-size (260 x 108 drawn at 0.5 scale feel)

const ago = (t: string, now: number) => { const s = Math.max(0, Math.round((now - +new Date(t)) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
const clock = (t: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

export default function MissionControl({ initial }: { initial: Data }) {
  const [data, setData] = useState<Data>(initial);
  const [callId, setCallId] = useState<string | null>(initial.callId);
  const [now, setNow] = useState(Date.now());
  const [hover, setHover] = useState<NodeId | null>(null);
  const [mode, setMode] = useState<"prompt" | "say">("prompt");
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/mission${callId ? `?callId=${encodeURIComponent(callId)}` : ""}`, { cache: "no-store" });
    if (r.ok) setData(await r.json());
  }, [callId]);
  useEffect(() => { void load(); const t = setInterval(() => { if (!document.hidden) void load(); }, 1500); return () => clearInterval(t); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);

  // Traffic window: the last 10 minutes, or the 10 minutes before the newest op when the call is quiet.
  const newest = data.ops[0] ? +new Date(data.ops[0].at) : now;
  const live = now - newest < 60_000;
  const windowEnd = live ? now : newest;
  const inWin = data.ops.filter((o) => windowEnd - +new Date(o.at) < 600_000);
  const edgeN = useMemo(() => { const m = new Map<EdgeId, number>(); for (const o of inWin) for (const e of o.edges) m.set(e, (m.get(e) ?? 0) + 1); return m; }, [inWin]);
  const nodeLast = useMemo(() => { const m = new Map<NodeId, Op>(); for (const o of data.ops) { if (!m.has(o.node)) m.set(o.node, o); for (const e of o.edges) for (const n of [EDGES[e].a, EDGES[e].b]) if (!m.has(n)) m.set(n, o); } return m; }, [data.ops]);
  const hot = (t?: string) => !!t && now - +new Date(t) < 8000;
  const edgeHot = (e: EdgeId) => data.ops.some((o) => o.edges.includes(e) && hot(o.at));
  const maxN = Math.max(1, ...edgeN.values());
  const face: GomonStateKey = data.ops[0] && hot(data.ops[0].at) ? VERB_FACE[data.ops[0].verb] ?? "listening" : live ? "listening" : "vetoed";
  const ctx = data.context;
  const lock = ctx?.open?.find((i: any) => i.status === "locking" && i.lockAnnouncedAt);
  const lockLeft = lock ? Math.ceil((+new Date(lock.lockAnnouncedAt) + lock.vetoMs - now) / 1000) : 0;

  async function send() {
    if (!text.trim() || !data.callId) return;
    setBusy(true); setNote(null);
    const r = await fetch("/api/mission/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: data.callId, mode, text }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { setText(""); setNote(mode === "say" ? "Queued. The bot speaks it in the call." : "Sent to Gomon as a typed turn. Watch the canvas."); void load(); }
    else setNote(j.error ?? `Failed (${r.status})`);
  }

  const path = (e: EdgeId) => {
    const { a, b, bend = 0 } = EDGES[e]; const A = NODES[a], B = NODES[b];
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2 + bend;
    return `M${A.x},${A.y} Q${mx},${my} ${B.x},${B.y}`;
  };

  return (
    <div className="mc">
      <header className="p-head">
        <div>
          <span className="eyebrow">Mission control</span>
          <h1>{ctx?.title ?? "No session"}</h1>
          <div className="mc-calls">
            {data.calls.map((c) => <button key={c._id} className="chip" aria-pressed={c._id === data.callId} onClick={() => setCallId(c._id)}>{c._id}</button>)}
          </div>
        </div>
        <div className="mc-status">
          <GomonAvatar state={face} size={64} />
          <div>
            <span className={`mc-signal ${live ? "on" : ""}`}><span className="live-dot" data-muted={live ? undefined : "1"} />{live ? "Live" : `Quiet · last op ${data.ops[0] ? ago(data.ops[0].at, now) : "—"} ago`}</span>
            <b>{lock && lockLeft > 0 ? `Locking · ${lockLeft}s to veto` : data.ops[0] && hot(data.ops[0].at) ? data.ops[0].verb : live ? "Listening" : "Standing by"}</b>
            <span className="muted small">{ctx?.participants?.join(", ") || "—"} · memory {ctx?.memoryEnabled ? "on" : "off"}</span>
          </div>
        </div>
      </header>

      <section className="p-card mc-canvas">
        <div className="p-card-h"><h2>Visual reasoning</h2><span className="muted small">{inWin.length} ops in {live ? "the last 10 min" : "the last active 10 min"} · line width = traffic</span></div>
        <div className="mc-svgwrap">
          <svg viewBox="0 0 1140 480" role="img" aria-label="Gomon system canvas">
            <defs><pattern id="mc-dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="rgba(11,21,16,.09)" /></pattern></defs>
            <rect x="0" y="0" width="1140" height="480" fill="url(#mc-dots)" />
            {(Object.keys(EDGES) as EdgeId[]).map((e) => {
              const n = edgeN.get(e) ?? 0; const h = edgeHot(e);
              return (
                <g key={e} className={`mc-edge ${n ? "on" : ""} ${h ? "hot" : ""}`}>
                  <path d={path(e)} className="mc-edge-base" />
                  {n > 0 && <path d={path(e)} className="mc-edge-flow" style={{ strokeWidth: 1.5 + (n / maxN) * 4 }} />}
                </g>
              );
            })}
            {(Object.keys(NODES) as NodeId[]).map((id) => {
              const N = NODES[id]; const last = nodeLast.get(id); const isHot = hot(last?.at);
              return (
                <g key={id} className={`mc-node ${isHot ? "hot" : ""} ${hover === id ? "hover" : ""}`} transform={`translate(${N.x - W / 2 - 20},${N.y - H / 2})`} onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)}>
                  <rect width={W + 40} height={H} rx="14" className="mc-node-card" />
                  <circle cx="18" cy="17" r="3.5" className="mc-node-dot" />
                  <text x="28" y="20" className="mc-node-kind">{N.kind}</text>
                  <text x="16" y="39" className="mc-node-title">{N.title}</text>
                  <text x="16" y="54" className="mc-node-sub">{last ? `${last.verb.toLowerCase()} · ${ago(last.at, now)} ago` : N.sub}</text>
                </g>
              );
            })}
          </svg>
          {hover && (
            <div className="mc-hovercard" style={{ left: `${(NODES[hover].x / 1140) * 100}%`, top: `${((NODES[hover].y + 34) / 480) * 100}%` }}>
              <span className="eyebrow">{NODES[hover].kind} · {NODES[hover].sub}</span>
              {data.ops.filter((o) => o.node === hover || o.edges.some((e) => EDGES[e].b === hover)).slice(0, 4).map((o) => <div key={o.id}><b>{o.verb}</b> {o.text}</div>)}
            </div>
          )}
        </div>
      </section>

      <section className="mc-grid">
        <div className="p-card mc-stream">
          <div className="p-card-h"><h2>Reasoning stream</h2><span className="muted small">every op is an Atlas write</span></div>
          <ol>
            {data.ops.slice(0, 40).map((o) => (
              <li key={o.id} data-hot={hot(o.at) ? "1" : undefined}>
                <time>{clock(o.at)}</time>
                <span className={`mc-verb v-${o.verb}`}>{o.verb}</span>
                <span className="mc-op"><span className="mono muted">{o.rw === "read" ? "read" : "write"} {o.coll}{o.ms != null ? ` · ${o.ms}ms` : ""}</span>{o.who ? <b> {o.who}</b> : null} {o.text}</span>
              </li>
            ))}
          </ol>
          {!data.ops.length && <div className="p-empty">Nothing yet. Start a call or send a prompt.</div>}
        </div>

        <div className="mc-side">
          <div className="p-card">
            <div className="p-card-h"><h2>Command</h2><div className="pills"><button className="chip" aria-pressed={mode === "prompt"} onClick={() => setMode("prompt")}>Prompt Gomon</button><button className="chip" aria-pressed={mode === "say"} onClick={() => setMode("say")}>Say in call</button></div></div>
            <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }}
              placeholder={mode === "prompt" ? "Ask or steer Gomon, e.g. what did we decide about rate limits?" : "Gomon will say this out loud in the meeting"} />
            <div className="btns"><button className="btn blue sm" disabled={busy || !text.trim() || !data.callId} onClick={send}>{busy ? "Sending" : mode === "prompt" ? "Send prompt" : "Speak"}</button><span className="muted small">{note ?? (mode === "prompt" ? "Typed turn from Mission control. Locks and sends still need a team member." : "Goes to says, the bot speaks it.")}</span></div>
          </div>

          <div className="p-card">
            <div className="p-card-h"><h2>Context</h2>{ctx?.lastRun && <span className="muted small">last run {ago(ctx.lastRun.at, now)} ago · {ctx.lastRun.recalled} recalled</span>}</div>
            <span className="eyebrow">Heard</span>
            <ul className="mc-ctx">{(ctx?.heard ?? []).map((h: any, i: number) => <li key={i}><b>{h.who}</b> {h.text}</li>)}</ul>
            <span className="eyebrow">Recalled from memory</span>
            <ul className="mc-ctx">{(ctx?.recalled ?? []).length ? ctx.recalled.map((m: any, i: number) => <li key={i}><b className="mono">{m.key ?? m.kind}</b> {m.text}</li>) : <li className="muted">Nothing recalled on the last run.</li>}</ul>
            <span className="eyebrow">Open items</span>
            <ul className="mc-ctx">{(ctx?.open ?? []).length ? ctx.open.map((m: any, i: number) => <li key={i}><span className={`pill ${m.status === "locking" ? "warn" : ""}`}>{m.status}</span> {m.text}</li>) : <li className="muted">No open items.</li>}</ul>
          </div>
        </div>
      </section>
    </div>
  );
}
