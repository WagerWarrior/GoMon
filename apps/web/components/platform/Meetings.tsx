"use client";
/**
 * Start a meeting (Gomon joins the Meet through Recall, in the chosen project and template) and take Gomon out again.
 * The worker checks the start_meeting policy for the person starting it and audits both; this only collects the inputs.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { send } from "./Templates";

type Opt = { id: string; name: string };
const ACTOR_KEY = "gomon.actor"; // same key as the session workspace's "Acting as" picker

export function StartMeeting({ worker, projects, templates, people, defaults }: { worker: { ok: boolean; base: string }; projects: Opt[]; templates: Opt[]; people: string[]; defaults: { project: string; template: string } }) {
  const router = useRouter();
  const [f, setF] = useState({ meetingUrl: "", title: "", projectId: defaults.project, templateId: defaults.template });
  const [actor, setActor] = useState(people[0] ?? "");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const saved = localStorage.getItem(ACTOR_KEY); if (saved && people.includes(saved)) setActor(saved); }, [people]);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  // Links copied from Meet often lack the scheme ("meet.google.com/abc-defg-hij").
  const raw = f.meetingUrl.trim();
  const url = raw && !/^https?:\/\//i.test(raw) ? `https://${raw}` : raw.replace(/^http:\/\//i, "https://");
  // The worker check ran at page load; a restart since then must not leave the button dead (the request reports errors).
  const ready = /^https:\/\/\S+\.\S+/.test(url) && !!f.projectId && !!actor;
  async function start() {
    setBusy(true); setErr(null);
    try {
      localStorage.setItem(ACTOR_KEY, actor);
      const r = await send("POST", "meetings", { meetingUrl: url, title: f.title.trim() || undefined, projectId: f.projectId, templateId: f.templateId || undefined, actor });
      router.push(`/sessions/${encodeURIComponent(r.callId)}?tab=live`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <article className="p-card tp-card tp-form mt-form">
      <div className={`mt-worker ${worker.ok ? "ok" : "off"}`}><i />{worker.ok ? "Worker online: Gomon can join now" : <>Worker offline at <code>{worker.base}</code>. Start apps/worker on this machine or set WORKER_URL to the live one.</>}</div>
      <input className="tp-in tp-name" value={f.meetingUrl} placeholder="https://meet.google.com/abc-defg-hij" aria-label="Meeting link" onChange={(e) => set("meetingUrl", e.target.value)} />
      <input className="tp-in" value={f.title} placeholder="Title, e.g. Rate limits design review" aria-label="Title" onChange={(e) => set("title", e.target.value)} />
      <div className="tp-row">
        <label>Project<select value={f.projectId} onChange={(e) => set("projectId", e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Template<select value={f.templateId} onChange={(e) => set("templateId", e.target.value)}>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      </div>
      <div className="tp-row tp-actions">
        <label>Start as<select value={actor} onChange={(e) => setActor(e.target.value)}>{people.map((p) => <option key={p}>{p}</option>)}</select></label>
        <button className="btn blue sm" disabled={busy || !ready} onClick={start}>{busy ? "Sending Gomon" : "Start meeting"}</button>
      </div>
      {err && <p className="tp-err">{err}</p>}
      <p className="muted small">Gomon reads this project&apos;s memory plus company context, and writes only to this project. Admit &ldquo;Gomon&rdquo; when it asks to join.</p>
    </article>
  );
}

export function LeaveMeeting({ callId }: { callId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function leave() {
    setBusy(true); setErr(null);
    try {
      const r = await send("POST", `meetings/${encodeURIComponent(callId)}/leave`, { actor: localStorage.getItem(ACTOR_KEY) ?? undefined });
      if (r.recallError) setErr(`Call ended; Recall said: ${r.recallError}`);
      router.refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <span className="mt-leave">
      <button className="btn sm" disabled={busy} onClick={leave}>{busy ? "Removing" : "Remove Gomon"}</button>
      {err && <em className="tp-err">{err}</em>}
    </span>
  );
}
