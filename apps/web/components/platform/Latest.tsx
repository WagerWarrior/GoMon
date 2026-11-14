/** "What just happened": the latest things Gomon did across sessions, as small tickets (no per-second noise). */
import Link from "next/link";
import type { ActivityRow, SessionRow } from "@/lib/platform";
import { clock } from "@/lib/format";

const icon = (k: string) => (/lock|promot/.test(k) ? "✓" : /veto|reject/.test(k) ? "×" : /conflict|already/.test(k) ? "!" : /^said/.test(k) ? "“" : /·/.test(k) ? "↗" : "•");

export default function Latest({ rows, sessions, n = 8 }: { rows: ActivityRow[]; sessions: SessionRow[]; n?: number }) {
  const title = new Map(sessions.map((s) => [s.id, s.title]));
  const pick = rows.filter((r) => !/^agent run|^ask |user login|session categorized|workflow (enabled|disabled)/.test(r.kind)).slice(0, n);
  return (
    <ul className="lt">
      {pick.map((r, i) => (
        <li key={i} className={`lt-${r.tone ?? "n"}`}>
          <span className="lt-ico">{icon(r.kind)}</span>
          <span className="lt-main"><b>{r.kind}</b><span>{r.text || r.actor}</span></span>
          {r.callId ? <Link href={`/sessions/${encodeURIComponent(r.callId)}`} className="lt-s">{title.get(r.callId) ?? r.callId}</Link> : <span className="lt-s muted">workspace</span>}
          <time>{clock(r.at)}</time>
        </li>
      ))}
      {!pick.length && <li className="muted small">Nothing yet.</li>}
    </ul>
  );
}
