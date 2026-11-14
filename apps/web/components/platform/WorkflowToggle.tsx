"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
/** On/off switch for a stored workflow. */
export default function WorkflowToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter(); const [on, setOn] = useState(enabled); const [busy, setBusy] = useState(false);
  async function flip() {
    setBusy(true); const next = !on; setOn(next);
    const r = await fetch(`/api/workflows/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: next, actor: "Max" }) });
    if (!r.ok) setOn(!next); setBusy(false); router.refresh();
  }
  return <button className="wf-switch" role="switch" aria-checked={on} disabled={busy} onClick={flip}><i />{on ? "On" : "Off"}</button>;
}
