"use client";
/**
 * Database picker for the composer: quote real Atlas items into a message. Four sources (memory, this call,
 * transcript, past meetings); memory searches by meaning through the Atlas vector index, or by key.
 * Click toggles an item on or off; the panel stays open so several can be picked.
 */
import { useEffect, useRef, useState } from "react";
import { SOURCES, type Hit, type Source } from "@/lib/context";

export const DbIcon = ({ size = 14 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
    <ellipse cx="8" cy="3.8" rx="5" ry="1.9" /><path d="M3 3.8v8.4c0 1 2.2 1.9 5 1.9s5-.9 5-1.9V3.8M3 8c0 1 2.2 1.9 5 1.9S13 9 13 8" />
  </svg>
);

const MODE: Record<string, string> = { meaning: "by meaning · Atlas vector search", key: "by key", words: "by words", all: "all active", recent: "newest first" };

export default function ContextPicker({ callId, picked, onToggle, disabled }: { callId: string; picked: string[]; onToggle: (h: Hit) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState<Source>("memory");
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ rows: Hit[]; mode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setBusy(true);
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/context?callId=${encodeURIComponent(callId)}&src=${src}&q=${encodeURIComponent(q)}`, { signal: ctl.signal })
        .then((r) => r.json()).then((j) => { setRes(j); setBusy(false); }).catch(() => {});
    }, q ? 220 : 0);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [open, src, q, callId]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);

  const on = new Set(picked);
  const count = picked.filter((k) => !k.startsWith("file:")).length;
  const hint = SOURCES.find((s) => s.key === src)!.hint;
  return (
    <div className="cx" ref={box}>
      <button className="ch-pill cx-btn" onClick={() => setOpen(!open)} disabled={disabled} aria-expanded={open} title="Quote memory, facts, this call or past meetings from Atlas">
        <DbIcon />Database{count > 0 && <em>{count}</em>}
      </button>
      {open && (
        <div className="cx-pop" role="dialog" aria-label="Add context from the database">
          <nav className="cx-tabs">{SOURCES.map((s) => <button key={s.key} aria-pressed={src === s.key} onClick={() => { setSrc(s.key); setRes(null); }}>{s.label}</button>)}</nav>
          <div className="cx-search"><DbIcon size={13} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={hint} aria-label="Search the database" /></div>
          <ul className="cx-list">
            {(res?.rows ?? []).map((h) => {
              const sel = on.has(`${h.src}:${h.id}`);
              return (
                <li key={h.id}>
                  <button aria-pressed={sel} onClick={() => onToggle(h)}>
                    <span className="cx-check" aria-hidden>{sel ? "✓" : "+"}</span>
                    <span className="cx-body">
                      <span className="cx-top"><b className={h.src === "memory" ? "mono" : ""}>{h.title}</b>{h.tag && <span className={`cx-tag t-${h.tag.replace(/\s/g, "-")}`}>{h.tag}</span>}{h.meta && <span className="cx-meta">{h.meta}</span>}{h.score != null && <span className="cx-score">{h.score.toFixed(2)}</span>}</span>
                      <span className="cx-text">{h.text}</span>
                    </span>
                  </button>
                </li>
              );
            })}
            {res && !res.rows.length && <li className="cx-empty">Nothing here{q ? ` for “${q}”` : ""}.</li>}
            {!res && <li className="cx-empty">Reading Atlas…</li>}
          </ul>
          <footer className="cx-foot"><span>{busy ? "Searching…" : res ? `${res.rows.length} · ${MODE[res.mode] ?? res.mode}` : ""}</span><span>{count ? `${count} attached` : "Click to attach"}</span></footer>
        </div>
      )}
    </div>
  );
}
