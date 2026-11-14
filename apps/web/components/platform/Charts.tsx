"use client";
/**
 * Mission-style charts: one series each, thin leaf line, recessive grid, mono ticks, crosshair + tooltip on hover.
 * Text stays in ink tokens; the leaf mark carries identity (dataviz rules).
 */
import { useEffect, useRef, useState } from "react";

type Unit = "ms" | "n";
const FMT: Record<Unit, (v: number) => string> = { n: (v) => String(Math.round(v * 10) / 10), ms: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`) };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null); const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width))); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const hhmm = (t: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function TimeArea({ data, height = 200, unit = "n", label }: { data: { t: string; v: number }[]; height?: number; unit?: Unit; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>(); const [hi, setHi] = useState<number | null>(null); const fmt = FMT[unit];
  if (!data.length) return <div className="p-empty">No data yet</div>;
  const pad = { l: 38, r: 10, t: 12, b: 24 }; const iw = w - pad.l - pad.r; const ih = height - pad.t - pad.b;
  const max = Math.max(1, ...data.map((d) => d.v)); const nice = niceMax(max);
  const x = (i: number) => pad.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / nice) * ih;
  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.v).toFixed(1)}`).join("");
  const area = `${line}L${x(data.length - 1)},${pad.t + ih}L${x(0)},${pad.t + ih}Z`;
  const ticks = [0, nice / 2, nice]; const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 90))));
  const move = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect(); const px = e.clientX - r.left;
    setHi(Math.max(0, Math.min(data.length - 1, Math.round(((px) / r.width) * (data.length - 1)))));
  };
  const h = hi == null ? null : data[hi];
  return (
    <div ref={ref} className="p-chart">
      <svg width={w} height={height} role="img" aria-label={label}>
        <defs><linearGradient id={`g-${label}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--leaf)" stopOpacity=".18" /><stop offset="1" stopColor="var(--leaf)" stopOpacity="0" /></linearGradient></defs>
        {ticks.map((t) => <g key={t}><line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="p-grid" /><text x={pad.l - 8} y={y(t) + 3} textAnchor="end" className="p-tick">{fmt(t)}</text></g>)}
        {data.map((d, i) => i % every === 0 && <text key={d.t} x={x(i)} y={height - 6} textAnchor="middle" className="p-tick">{hhmm(d.t)}</text>)}
        <path d={area} fill={`url(#g-${label})`} />
        <path d={line} fill="none" stroke="var(--leaf)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {h && <g><line x1={x(hi!)} x2={x(hi!)} y1={pad.t} y2={pad.t + ih} className="p-cross" /><circle cx={x(hi!)} cy={y(h.v)} r="4.5" fill="var(--leaf)" stroke="var(--solid)" strokeWidth="2" /></g>}
        <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent" onMouseMove={move} onMouseLeave={() => setHi(null)} />
      </svg>
      {h && <div className="p-tip" style={{ left: Math.min(w - 140, Math.max(0, x(hi!) - 60)), top: 0 }}><span className="eyebrow">{hhmm(h.t)}</span><b>{fmt(h.v)}</b></div>}
    </div>
  );
}

function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** Horizontal bars with a value label; optional second value drawn as a thin tick (p95 against p50). */
export function HBars({ rows, unit = "n", tickLabel }: { rows: { label: string; v: number; tick?: number | null; note?: string }[]; unit?: Unit; tickLabel?: string }) {
  const [hi, setHi] = useState<number | null>(null); const fmt = FMT[unit];
  if (!rows.length) return <div className="p-empty">No data yet</div>;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.v, r.tick ?? 0)));
  return (
    <div className="p-hbars">
      {rows.map((r, i) => (
        <div key={r.label} className="p-hbar" data-hi={hi === i ? "1" : undefined} onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}>
          <span className="p-hbar-l">{r.label}</span>
          <span className="p-hbar-track">
            <i style={{ width: `${(r.v / max) * 100}%` }} />
            {r.tick != null && <em style={{ left: `${(r.tick / max) * 100}%` }} title={`${tickLabel ?? ""} ${fmt(r.tick)}`} />}
          </span>
          <span className="p-hbar-v">{fmt(r.v)}{hi === i && r.tick != null ? <span className="muted"> · {tickLabel} {fmt(r.tick)}</span> : null}{hi === i && r.note ? <span className="muted"> · {r.note}</span> : null}</span>
        </div>
      ))}
    </div>
  );
}

/** Thin segmented stage strip: heard -> proposed -> locked, like a launch sequence. */
export function Funnel({ steps }: { steps: { label: string; n: number }[] }) {
  const max = Math.max(1, steps[0]?.n ?? 1);
  return (
    <ol className="p-funnel">
      {steps.map((s, i) => (
        <li key={s.label}>
          <span className="eyebrow">{String(i + 1).padStart(2, "0")} · {s.label}</span>
          <b>{s.n}</b>
          <span className="p-funnel-bar"><i style={{ width: `${(s.n / max) * 100}%` }} /></span>
          <span className="muted small">{i === 0 ? "items extracted" : `${Math.round((s.n / max) * 100)}% of heard`}</span>
        </li>
      ))}
    </ol>
  );
}
