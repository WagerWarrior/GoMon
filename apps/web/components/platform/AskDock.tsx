"use client";
/** Ask Gomon, bottom right on every page: instant Status and Summarize from Atlas, Think = a memory-grounded answer. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Msg = { who: "you" | "gomon"; title?: string; lines: string[]; links?: { label: string; href: string }[]; meta?: string };

export default function AskDock() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const callId = path.startsWith("/sessions/") ? decodeURIComponent(path.split("/")[2] ?? "") : undefined;
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, busy]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); } if (e.key === "Escape") setOpen(false); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, []);

  async function run(cmd: "status" | "summarize" | "think", q?: string) {
    const ask = cmd === "think" ? (q ?? text).trim() : "";
    if (cmd === "think" && !ask) return;
    setMsgs((m) => [...m, { who: "you", lines: [cmd === "think" ? ask : cmd === "status" ? "Status" : callId ? "Summarize this session" : "Summarize the latest session"] }]);
    setText(""); setBusy(true);
    try {
      if (cmd === "think") {
        const r = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: ask, memory: true, callId, actor: "Ask Gomon" }) });
        const j = await r.json();
        setMsgs((m) => [...m, r.ok ? { who: "gomon", lines: [j.answer], meta: `${j.answeredBy === "llm" ? j.model : "from memory"} · ${j.ms}ms · ${j.cited?.length ?? 0} cited`, links: (j.cited ?? []).slice(0, 3).map((c: any) => ({ label: c.key ?? "memory", href: "/memory" })) } : { who: "gomon", lines: [j.error ?? "Failed"] }]);
      } else {
        const r = await fetch("/api/assist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd, callId }) });
        const j = await r.json();
        setMsgs((m) => [...m, r.ok ? { who: "gomon", ...j } : { who: "gomon", lines: [j.error ?? "Failed"] }]);
      }
    } catch { setMsgs((m) => [...m, { who: "gomon", lines: ["Could not reach the server."] }]); }
    setBusy(false);
  }

  return (
    <>
      <button className="ad-fab" aria-expanded={open} onClick={() => setOpen(!open)}><span className="ad-led" />Ask Gomon<kbd>⌘K</kbd></button>
      {open && (
        <aside className="ad-panel" aria-label="Ask Gomon">
          <div className="ad-h"><b>Ask Gomon</b><span className="muted small">{callId ? "this session" : "whole workspace"}</span><button className="ad-x" onClick={() => setOpen(false)} aria-label="Close">×</button></div>
          <div className="ad-body">
            {!msgs.length && <div className="ad-empty"><b>What do you need?</b><span className="muted small">Status and Summarize answer from Atlas instantly. Think asks Gomon with team memory.</span></div>}
            {msgs.map((m, i) => (
              <div key={i} className={`ad-msg ${m.who}`}>
                {m.title && <b>{m.title}</b>}
                {m.lines.map((l, j) => <p key={j}>{l}</p>)}
                {m.meta && <span className="muted small">{m.meta}</span>}
                {!!m.links?.length && <div className="ad-links">{m.links.map((l, j) => <Link key={j} href={l.href} onClick={() => setOpen(false)}>{l.label} →</Link>)}</div>}
              </div>
            ))}
            {busy && <div className="ad-msg gomon"><span className="ad-dots"><i /><i /><i /></span></div>}
            <div ref={end} />
          </div>
          <div className="ad-cmds">
            <button onClick={() => run("summarize")} disabled={busy}>Summarize</button>
            <button onClick={() => run("status")} disabled={busy}>Status</button>
            <button onClick={() => run("think")} disabled={busy || !text.trim()}>Think</button>
          </div>
          <div className="ad-in">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void run("think"); }} placeholder="Ask about decisions, people, past calls…" autoFocus />
            <button className="sb-send" disabled={busy || !text.trim()} onClick={() => run("think")} aria-label="Ask"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg></button>
          </div>
        </aside>
      )}
    </>
  );
}
