"use client";
/**
 * One session, live. Visual reasoning as a straight line of stages (hear -> search -> think -> write -> lock -> speak -> send).
 * Each stage animates when a real Atlas op for this call lands, and clicking it shows what Gomon did there.
 * The operator can prompt Gomon or make it speak in this call (both are Atlas writes; see lib/mission.ts).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Op, Verb } from "@/lib/mission";

type Data = { now: string; callId: string | null; ops: Op[]; context: any };
type StageKey = "hear" | "search" | "think" | "write" | "lock" | "speak" | "send";
const STAGES: { key: StageKey; title: string; verbs: Verb[]; where: string }[] = [
  { key: "hear", title: "Hear", verbs: ["LISTEN", "OPERATOR", "WAKE"], where: "utterances" },
  { key: "search", title: "Search memory", verbs: ["SEARCH"], where: "memories · vector + text" },
  { key: "think", title: "Think", verbs: ["THINK", "FLAG"], where: "reasoning model" },
  { key: "write", title: "Write", verbs: ["APPEND"], where: "call_items" },
  { key: "lock", title: "Lock", verbs: ["LOCK", "VETO"], where: "memories · audit" },
  { key: "speak", title: "Speak", verbs: ["SPEAK"], where: "says · voice" },
  { key: "send", title: "Send", verbs: ["SEND"], where: "outbox · connected tools" },
];
const stageOf = (o: Op): StageKey => (o.verb === "OPERATOR" && o.coll === "says" ? "speak" : STAGES.find((s) => s.verbs.includes(o.verb))?.key ?? "think");
const ago = (t: string, now: number) => { const s = Math.max(0, Math.round((now - +new Date(t)) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
const clock = (t: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

export default function SessionLive({ callId, initial }: { callId: string; initial: Data }) {
  const [data, setData] = useState<Data>(initial);
  const [now, setNow] = useState(Date.now());
  const [sel, setSel] = useState<StageKey | null>(null);
  const [all, setAll] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/mission?callId=${encodeURIComponent(callId)}`, { cache: "no-store" });
    if (r.ok) setData(await r.json());
  }, [callId]);
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) void load(); }, 1500); return () => clearInterval(t); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);

  const byStage = useMemo(() => { const m = new Map<StageKey, Op[]>(); for (const o of data.ops) { const k = stageOf(o); (m.get(k) ?? m.set(k, []).get(k)!).push(o); } return m; }, [data.ops]);
  const fresh = (o?: Op) => !!o && now - +new Date(o.at) < 8000;
  const live = data.ops[0] ? now - +new Date(data.ops[0].at) < 5 * 60_000 : false;
  const ctx = data.context;
  const lock = ctx?.open?.find((i: any) => i.status === "locking" && i.lockAnnouncedAt);
  const lockLeft = lock ? Math.ceil((+new Date(lock.lockAnnouncedAt) + lock.vetoMs - now) / 1000) : 0;
  const ops = sel ? byStage.get(sel) ?? [] : data.ops;

  // At most three stages on screen: the last three distinct stages Gomon went through, oldest to newest.
  const flow = useMemo(() => {
    const seen: StageKey[] = []; const at = new Map<StageKey, Op>();
    for (const o of data.ops) { const k = stageOf(o); if (!seen.includes(k)) { seen.push(k); at.set(k, o); } if (seen.length === 3) break; }
    return seen.reverse().map((k) => ({ s: STAGES.find((x) => x.key === k)!, op: at.get(k)! }));
  }, [data.ops]);

  return (
    <div className="sl">
      <section className="p-card sl-line">
        <div className="p-card-h">
          <h2>Visual reasoning</h2>
          <span className="sl-status"><span className={`sl-led ${live ? "on" : ""}`} />{lock && lockLeft > 0 ? `Locking · ${lockLeft}s to veto` : live ? (fresh(data.ops[0]) ? `${data.ops[0].verb.toLowerCase()} now` : "listening") : `quiet · last ${data.ops[0] ? ago(data.ops[0].at, now) : "—"} ago`}</span>
        </div>
        <div className="sl-flow">
          {flow.map(({ s: st, op }, i) => {
            const on = fresh(op); const latest = i === flow.length - 1;
            return (
              <div key={st.key} className="sl-flowitem">
                {i > 0 && <span className="sl-link" data-on={on ? "1" : undefined} aria-hidden><i /></span>}
                <button className="sl-node" data-on={on ? "1" : undefined} data-latest={latest ? "1" : undefined} onClick={() => setSel(sel === st.key ? null : st.key)}>
                  <Art k={st.key} />
                  <b>{st.title}</b>
                  <span className="sl-where">{st.where}</span>
                  <span className="sl-optext">{op.who ? `${op.who}: ` : ""}{op.text}</span>
                  <span className="sl-last">{ago(op.at, now)} ago{op.ms != null ? ` · ${op.ms}ms` : ""}</span>
                </button>
              </div>
            );
          })}
          {!flow.length && <div className="p-empty">Nothing yet. Stages light up as Gomon hears, searches, thinks and writes.</div>}
        </div>
        <div className="sl-rail" role="group" aria-label="Filter the trace by stage">
          {STAGES.map((st) => {
            const list = byStage.get(st.key) ?? [];
            return <button key={st.key} aria-pressed={sel === st.key} data-on={fresh(list[0]) ? "1" : undefined} onClick={() => setSel(sel === st.key ? null : st.key)}><i />{st.title}<span>{list.length}</span></button>;
          })}
        </div>
      </section>

      <section className="sl-grid">
        <div className="p-card sl-trace">
          <div className="p-card-h"><h2>{sel ? STAGES.find((s) => s.key === sel)!.title : "Trace"}</h2>{sel && <button className="chip" onClick={() => setSel(null)}>All stages</button>}</div>
          <ol>
            {(all ? ops : ops.slice(0, 14)).map((o) => (
              <li key={o.id} data-on={fresh(o) ? "1" : undefined}>
                <time>{clock(o.at)}</time>
                <span className={`mc-verb v-${o.verb}`}>{o.verb}</span>
                <span className="sl-op">{o.who && <b>{o.who} </b>}{o.text}<span className="mono muted"> {o.rw} {o.coll}{o.ms != null ? ` · ${o.ms}ms` : ""}</span></span>
              </li>
            ))}
          </ol>
          {!ops.length && <div className="p-empty">Nothing yet.</div>}
          {ops.length > 14 && <button className="p-more sl-all" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${ops.length}`}</button>}
        </div>

        <div className="sl-side">
          <div className="p-card">
            <div className="p-card-h"><h2>In Gomon's head</h2>{ctx?.lastRun && <span className="muted small">{ctx.lastRun.recalled} recalled</span>}</div>
            <span className="eyebrow">Recalled</span>
            <ul className="mc-ctx">{(ctx?.recalled ?? []).length ? ctx.recalled.map((m: any, i: number) => <li key={i}><b className="mono">{m.key ?? m.kind}</b> {m.text}</li>) : <li className="muted">Nothing on the last run.</li>}</ul>
            <span className="eyebrow">Open</span>
            <ul className="mc-ctx">{(ctx?.open ?? []).length ? ctx.open.map((m: any, i: number) => <li key={i}><span className={`pill ${m.status === "locking" ? "warn" : ""}`}>{m.status}</span> {m.text}</li>) : <li className="muted">No open items.</li>}</ul>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Small line drawings per stage; CSS animates them while the stage is active (data-on). */
function Art({ k }: { k: StageKey }) {
  const common = { viewBox: "0 0 64 40", width: 64, height: 40, className: `sl-art a-${k}`, "aria-hidden": true } as const;
  if (k === "hear") return <svg {...common}>{[8, 16, 24, 32, 40, 48, 56].map((x, i) => <rect key={x} x={x - 2} y={12} width="3" height="16" rx="1.5" style={{ animationDelay: `${i * 90}ms` }} />)}</svg>;
  if (k === "search" || k === "write" || k === "lock") return (
    <svg {...common}>
      <rect x="6" y="4" width="52" height="32" rx="3" className="tb" />
      {[0, 1, 2, 3].map((r) => <rect key={r} x="10" y={9 + r * 6.5} width="44" height="4" rx="1" className={`row r${r}`} />)}
      {k === "search" && <rect x="8" y="7" width="48" height="8" rx="2" className="scan" />}
      {k === "write" && <rect x="10" y="35" width="44" height="4" rx="1" className="new" />}
      {k === "lock" && <path d="M28 20v-3a4 4 0 0 1 8 0v3M26 20h12v9H26z" className="lk" />}
    </svg>
  );
  if (k === "think") return <svg {...common}>{[20, 32, 44].map((x, i) => <circle key={x} cx={x} cy="20" r="4" style={{ animationDelay: `${i * 160}ms` }} />)}</svg>;
  if (k === "speak") return <svg {...common}><path d="M10 8h36a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H24l-8 7v-7h-6a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z" className="tb" />{[18, 26, 34].map((x, i) => <rect key={x} x={x} y="15" width="4" height="6" rx="2" style={{ animationDelay: `${i * 120}ms` }} />)}<path d="M54 12q4 6 0 12M58 9q6 9 0 18" className="wave" /></svg>;
  return <svg {...common}><path d="M8 20 52 6 40 34 30 24z" className="tb" /><path d="M30 24 52 6" className="tb" /><circle cx="56" cy="30" r="3" className="ping" /></svg>;
}
