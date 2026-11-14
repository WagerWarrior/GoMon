"use client";
/** One click ends the meeting from the session: the call ends in Atlas, Gomon stops talking and leaves the Meet. */
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function EndMeeting({ callId }: { callId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function end() {
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(callId)}/end`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: localStorage.getItem("gomon.actor") ?? undefined }) });
      const j = (await r.json().catch(() => ({}))) as { bot?: string; error?: string };
      setNote(r.ok ? j.bot ?? "Ended" : j.error ?? `Failed (${r.status})`);
      router.refresh();
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <span className="em">
      <button className="em-btn" disabled={busy} onClick={end} title="Gomon stops talking and leaves the meeting"><i />{busy ? "Ending" : "End meeting"}</button>
      {note && <em className="em-note" title={note}>{note}</em>}
    </span>
  );
}
