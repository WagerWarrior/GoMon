"use client";
/** Beside a link Gomon filed: copy it, or send it into the meeting chat (the worker posts it through the bot). */
import { useState } from "react";

export default function ShareLink({ callId, url, label }: { callId: string; url: string; label: string }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(url); setNote("Copied"); } catch { setNote(url); }
  }
  async function send() {
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(callId)}/share`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, label, actor: localStorage.getItem("gomon.actor") ?? undefined }) });
      const j = (await r.json().catch(() => ({}))) as { status?: string; error?: string };
      setNote(j.status === "sent" ? "Sent to chat" : j.status === "requested" ? "Sending to chat" : j.error ?? `Failed (${r.status})`);
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <span className="sh">
      <button onClick={copy} title="Copy this link">Copy link</button>
      <button onClick={send} disabled={busy} title="Gomon posts this link in the meeting chat">{busy ? "Sending" : "Send to chat"}</button>
      {note && <em title={note}>{note}</em>}
    </span>
  );
}
