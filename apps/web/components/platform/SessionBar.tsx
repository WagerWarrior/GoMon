"use client";
/**
 * The session's command bar: view tabs on top, a live pulse (who is talking, is it transcribing, what Gomon is doing),
 * and one prompt box that steers Gomon or makes it speak in this call. Both are Atlas writes (lib/mission.ts command()).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type Op = { id: string; at: string; verb: string; text: string; who?: string };
const TABS = [["workspace", "Workspace"], ["live", "Live"], ["events", "Workflows & events"], ["transcript", "Transcript"], ["decisions", "Decisions"], ["timings", "Timings"], ["govern", "Govern"]] as const;
import { CATEGORIES } from "@/lib/categories";

export function pulse(ops: Op[], now: number) {
  const age = (o?: Op) => (o ? (now - +new Date(o.at)) / 1000 : Infinity);
  const heard = ops.find((o) => o.verb === "LISTEN" || o.verb === "OPERATOR");
  const doing = ops.find((o) => ["SEARCH", "THINK", "APPEND", "LOCK", "SPEAK", "SEND", "WAKE"].includes(o.verb));
  const ago = (s: number) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);
  if (heard && age(heard) < 12) return { tone: "on", text: `${heard.who ?? "Someone"} is talking`, sub: heard.text };
  if (doing && age(doing) < 10) {
    const verb: Record<string, string> = { SEARCH: "searching memory", THINK: "thinking", APPEND: "writing a decision", LOCK: "locking", SPEAK: "speaking", SEND: "sending", WAKE: "waking" };
    return { tone: "on", text: `Gomon is ${verb[doing.verb] ?? "working"}`, sub: doing.text };
  }
  if (heard && age(heard) < 300) return { tone: "idle", text: `Transcribing · last heard ${ago(age(heard))} ago`, sub: `${heard.who ?? ""}: ${heard.text}` };
  return { tone: "off", text: heard ? `Quiet · last heard ${ago(age(heard))} ago` : "Nothing heard yet", sub: heard ? `${heard.who ?? ""}: ${heard.text}` : "" };
}

export default function SessionBar({ callId, tab, initialOps }: { callId: string; tab: string; initialOps: Op[] }) {
  const router = useRouter();
  const [ops, setOps] = useState<Op[]>(initialOps);
  const [now, setNow] = useState(Date.now());
  const [mode, setMode] = useState<"prompt" | "say">("prompt");
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const [note, setNote] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(`/api/mission?callId=${encodeURIComponent(callId)}`, { cache: "no-store" }).catch(() => null);
    if (r?.ok) setOps(((await r.json()).ops ?? []).slice(0, 30));
  }, [callId]);
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) void load(); setNow(Date.now()); }, 2000); return () => clearInterval(t); }, [load]);
  const p = pulse(ops, now);

  async function send() {
    if (!text.trim()) return;
    setBusy(true); setNote(null);
    const r = await fetch("/api/mission/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId, mode, text }) });
    const j = await r.json().catch(() => ({})); setBusy(false);
    if (r.ok) { setText(""); setNote(mode === "say" ? "Queued. The bot speaks it next." : "Sent. Gomon wakes on it."); void load(); if (tab !== "live") router.refresh(); }
    else setNote(j.error ?? `Failed (${r.status})`);
  }

  return (
    <section className="sb">
      <nav className="sb-tabs">{TABS.map(([k, l]) => <Link key={k} href={`/sessions/${encodeURIComponent(callId)}?tab=${k}`} aria-current={tab === k ? "page" : undefined}>{l}</Link>)}</nav>
      <div className="sb-box">
        <div className="sb-pulse" data-tone={p.tone}><span className="sb-led" /><b>{p.text}</b>{p.sub && <span className="sb-sub">{p.sub}</span>}</div>
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder={mode === "prompt" ? "Ask Gomon or steer it in this call…" : "Gomon says this out loud in the call…"} aria-label="Prompt Gomon" />
        <div className="sb-foot">
          <div className="sb-modes" role="group" aria-label="Mode">
            <button aria-pressed={mode === "prompt"} onClick={() => setMode("prompt")}>Prompt</button>
            <button aria-pressed={mode === "say"} onClick={() => setMode("say")}>Say in call</button>
          </div>
          {note && <span className="muted small">{note}</span>}
          <button className="sb-send" disabled={busy || !text.trim()} onClick={send} aria-label="Send">{busy ? "…" : <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>}</button>
        </div>
      </div>
    </section>
  );
}

export function CategoryPicker({ callId, current }: { callId: string; current: string }) {
  const router = useRouter(); const [v, setV] = useState(current); const [busy, setBusy] = useState(false);
  return (
    <label className="sb-cat" title="Category">
      <select value={v} disabled={busy} onChange={async (e) => {
        const next = e.target.value; setV(next); setBusy(true);
        await fetch(`/api/sessions/${encodeURIComponent(callId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: next }) });
        setBusy(false); router.refresh();
      }}>{[...new Set([current, ...CATEGORIES])].map((c) => <option key={c}>{c}</option>)}</select>
    </label>
  );
}
