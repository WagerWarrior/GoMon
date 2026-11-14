"use client";
/** Template cards with inline edit/create, and the per-session template picker. Writes go to the worker via /api/worker. */
import { useRouter } from "next/navigation";
import { useState } from "react";

const KINDS = ["decision", "requirement", "constraint", "risk", "open_question", "action", "assumption", "interface", "alternative"];
type T = { _id: string; name: string; description?: string; persona?: string; proactivity: string; consensus: string; vetoMs: number; captureKinds: string[]; voiceId?: string; version?: number; sessions?: number; updatedBy?: string };

async function send(method: string, path: string, body: unknown) {
  const r = await fetch(`/api/worker/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ? `${j.error}${j.details ? ": " + [].concat(j.details).join(", ") : ""}` : `Failed (${r.status})`);
  return j;
}

export function TemplateGrid({ rows, leads }: { rows: T[]; leads: string[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const blank: T = { _id: "", name: "", description: "", persona: "", proactivity: "balanced", consensus: "announce_veto", vetoMs: 10000, captureKinds: KINDS.slice(0, 5) };
  return (
    <section className="tp-grid">
      {rows.map((t) => editing === t._id
        ? <TemplateForm key={t._id} t={t} leads={leads} onDone={() => setEditing(null)} />
        : (
          <article key={t._id} className="p-card tp-card">
            <div className="p-card-h"><h2>{t.name}</h2><span className="muted small">v{t.version ?? 1} · {t.sessions ?? 0} sessions</span></div>
            <p className="tp-desc">{t.description}</p>
            <dl className="tp-facts">
              <div><dt>Speaks</dt><dd>{t.proactivity}</dd></div>
              <div><dt>Locks</dt><dd>{t.consensus === "announce_veto" ? `announce, ${t.vetoMs / 1000}s veto` : "explicit only"}</dd></div>
              <div><dt>Voice</dt><dd>{t.voiceId ? "custom" : "default"}</dd></div>
            </dl>
            <div className="tp-kinds">{t.captureKinds.map((k) => <span key={k}>{k.replace(/_/g, " ")}</span>)}</div>
            {t.persona && <p className="tp-persona">“{t.persona}”</p>}
            <div className="btns"><button className="btn sm" onClick={() => setEditing(t._id)}>Edit</button></div>
          </article>
        ))}
      {editing === "new" ? <TemplateForm t={blank} leads={leads} onDone={() => setEditing(null)} /> : <button className="tp-new" onClick={() => setEditing("new")}>+ New template</button>}
    </section>
  );
}

function TemplateForm({ t, leads, onDone }: { t: T; leads: string[]; onDone: () => void }) {
  const router = useRouter();
  const [f, setF] = useState({ ...t }); const [actor, setActor] = useState(leads[0] ?? ""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: keyof T, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    setBusy(true); setErr(null);
    const body = { actor, name: f.name, description: f.description, persona: f.persona, proactivity: f.proactivity, consensus: f.consensus, vetoMs: Number(f.vetoMs), captureKinds: f.captureKinds, ...(f.voiceId ? { voiceId: f.voiceId } : {}) };
    try { await (t._id ? send("PUT", `templates/${t._id}`, body) : send("POST", "templates", body)); onDone(); router.refresh(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <article className="p-card tp-card tp-form">
      <input className="tp-in tp-name" value={f.name} placeholder="Template name" onChange={(e) => set("name", e.target.value)} />
      <input className="tp-in" value={f.description ?? ""} placeholder="One line on what it does" onChange={(e) => set("description", e.target.value)} />
      <textarea className="tp-in" rows={3} value={f.persona ?? ""} placeholder="Persona added to the analysis prompt" onChange={(e) => set("persona", e.target.value)} />
      <div className="tp-row">
        <label>Speaks<select value={f.proactivity} onChange={(e) => set("proactivity", e.target.value)}>{["quiet", "balanced", "active"].map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Locks<select value={f.consensus} onChange={(e) => set("consensus", e.target.value)}><option value="announce_veto">announce + veto</option><option value="explicit_only">explicit only</option></select></label>
        <label>Veto s<input type="number" min={3} max={60} value={f.vetoMs / 1000} onChange={(e) => set("vetoMs", Number(e.target.value) * 1000)} /></label>
      </div>
      <div className="tp-kinds edit">{KINDS.map((k) => <button key={k} type="button" aria-pressed={f.captureKinds.includes(k)} onClick={() => set("captureKinds", f.captureKinds.includes(k) ? f.captureKinds.filter((x) => x !== k) : [...f.captureKinds, k])}>{k.replace(/_/g, " ")}</button>)}</div>
      <input className="tp-in" value={f.voiceId ?? ""} placeholder="ElevenLabs voice id (optional)" onChange={(e) => set("voiceId", e.target.value)} />
      <div className="tp-row tp-actions">
        <label>Save as<select value={actor} onChange={(e) => setActor(e.target.value)}>{leads.map((l) => <option key={l}>{l}</option>)}</select></label>
        <button className="btn sm" onClick={onDone}>Cancel</button>
        <button className="btn blue sm" disabled={busy || !f.name.trim()} onClick={save}>{busy ? "Saving" : "Save"}</button>
      </div>
      {err && <p className="tp-err">{err}</p>}
    </article>
  );
}

export function TemplatePicker({ callId, current, options }: { callId: string; current: string; options: { id: string; name: string }[] }) {
  const router = useRouter(); const [v, setV] = useState(current); const [err, setErr] = useState<string | null>(null);
  async function pick(id: string) {
    const prev = v; setV(id); setErr(null);
    try { await send("PATCH", `calls/${encodeURIComponent(callId)}`, { templateId: id, actor: "Max" }); router.refresh(); }
    catch (e) { setV(prev); setErr((e as Error).message); }
  }
  return (
    <label className="tp-pick" title={err ?? "Agent template for this session"}>
      <span>Template</span>
      <select value={v} onChange={(e) => pick(e.target.value)}>{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
      {err && <em className="tp-err">{err}</em>}
    </label>
  );
}
