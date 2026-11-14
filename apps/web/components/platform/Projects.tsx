"use client";
/** Create a project. The worker checks create_project, audits it, and queues its GitHub Projects board when GitHub is configured. */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { send } from "./Templates";

const ACTOR_KEY = "gomon.actor";

export function NewProject({ people }: { people: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [actor, setActor] = useState(people[0] ?? "");
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { const saved = localStorage.getItem(ACTOR_KEY); if (saved && people.includes(saved)) setActor(saved); }, [people]);
  async function create() {
    setBusy(true); setMsg(null);
    try {
      localStorage.setItem(ACTOR_KEY, actor);
      const r = await send("POST", "projects", { name: name.trim(), description: description.trim() || undefined, actor });
      setMsg({ ok: true, text: `Created ${r.name}${r.boardQueued ? ". GitHub board queued." : "."}` });
      setName(""); setDescription(""); setOpen(false); router.refresh();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }
  if (!open) return (
    <div className="pj-new">
      <button className="tp-new pj-newbtn" onClick={() => setOpen(true)}>+ New project</button>
      {msg && <p className={msg.ok ? "muted small" : "tp-err"}>{msg.text}</p>}
    </div>
  );
  return (
    <article className="p-card tp-card tp-form">
      <input className="tp-in tp-name" value={name} placeholder="Project name" aria-label="Project name" onChange={(e) => setName(e.target.value)} />
      <input className="tp-in" value={description} placeholder="One line on what it is (optional)" aria-label="Description" onChange={(e) => setDescription(e.target.value)} />
      <div className="tp-row tp-actions">
        <label>Create as<select value={actor} onChange={(e) => setActor(e.target.value)}>{people.map((p) => <option key={p}>{p}</option>)}</select></label>
        <button className="btn sm" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn blue sm" disabled={busy || !name.trim() || !actor} onClick={create}>{busy ? "Creating" : "Create"}</button>
      </div>
      {msg && !msg.ok && <p className="tp-err">{msg.text}</p>}
    </article>
  );
}
