"use client";
/** Max (workspace): the spec's memory on/off proof. Same question, with and without team memory, side by side. */
import { useState } from "react";

type Cited = { id: string; key?: string; kind?: string; version?: number; text: string; score: number };
type Result = { answer: string; ms: number; cited: Cited[]; answeredBy?: "llm" | "retrieval"; model?: string; note?: string } | { error: string };

const SAMPLE = "Proposal: flat 100 requests per second per tenant for everyone, including enterprise";

export default function AskPanel({ callId, actor }: { callId: string; actor: string }) {
  const [q, setQ] = useState(SAMPLE);
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState<Result | null>(null);
  const [off, setOff] = useState<Result | null>(null);

  async function ask(memory: boolean): Promise<Result> {
    const r = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: q, memory, callId, actor }) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    return r.ok ? j : { error: j.error ?? `HTTP ${r.status}` };
  }
  async function run() {
    setBusy(true);
    const [a, b] = await Promise.all([ask(true), ask(false)]);
    setOn(a); setOff(b); setBusy(false);
  }

  return (
    <section className="card wide">
      <h2>Ask Gomon <span className="muted small">memory on vs off · Atlas Vector Search + Voyage</span></h2>
      <textarea value={q} onChange={(e) => setQ(e.target.value)} rows={2} aria-label="Question for Gomon" />
      <div className="btns top"><button className="btn blue" disabled={busy || !q.trim()} onClick={run}>{busy ? "Asking…" : "Ask both ways"}</button></div>
      {(on || off) && (
        <div className="ask-grid">
          <Side title="Memory on" r={on} />
          <Side title="Memory off" r={off} />
        </div>
      )}
    </section>
  );
}

function Side({ title, r }: { title: string; r: Result | null }) {
  if (!r) return null;
  if ("error" in r) return <div className="ask-side"><h3>{title}</h3><p className="badtxt">{r.error}</p></div>;
  return (
    <div className="ask-side">
      <h3>{title} <span className="muted small">{r.ms} ms · {r.cited.length} cited · {r.answeredBy === "llm" ? r.model : "retrieval only"}</span></h3>
      <p>{r.answer}</p>
      {r.note && <p className="muted small">{r.note}</p>}
      {r.cited.length > 0 && (
        <ul className="plain">
          {r.cited.map((c) => (
            <li key={c.id} className="cite">
              <span className="kind">{c.key ?? c.kind ?? "memory"}{c.version && c.version > 1 ? ` v${c.version}` : ""}</span>
              <span>{c.text}</span>
              <span className="muted small" title={c.id}>{c.score.toFixed(2)} · {c.id.slice(-6)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
