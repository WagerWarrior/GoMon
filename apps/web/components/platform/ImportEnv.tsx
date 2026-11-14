"use client";
/** Paste KEY=value lines (from a shell, a password manager export, another .env) and import them into the repo-root .env. */
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function ImportEnv() {
  const router = useRouter();
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  async function go() {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/integrations/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    const j = await r.json().catch(() => ({})); setBusy(false);
    if (r.ok) { setText(""); setMsg({ ok: true, t: `Set ${j.set.join(", ")}${j.skipped?.length ? `. Skipped unknown: ${j.skipped.join(", ")}` : ""}. Restart the worker and bot page to use them.` }); router.refresh(); }
    else setMsg({ ok: false, t: j.error ?? `Failed (${r.status})` });
  }
  return (
    <div className="ie">
      <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={"SLACK_BOT_TOKEN=xoxb-…\nGITHUB_TOKEN=ghp_…\nRECALL_API_KEY=…"} aria-label="Paste KEY=value lines" spellCheck={false} />
      <div className="ie-foot">
        <span className="muted small">Written to the repo-root <code>.env</code> on this computer. Values never leave it and are never shown again.</span>
        <button className="kh-btn dark" disabled={busy || !text.trim()} onClick={go}>{busy ? "Importing…" : "Import keys"}</button>
      </div>
      {msg && <span className={`small ${msg.ok ? "ok" : "badtxt"}`}>{msg.t}</span>}
    </div>
  );
}
