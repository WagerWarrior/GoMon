/** "What just happened": the latest things Gomon did, one row per session; expand a row for the specifics. */
import Link from "next/link";
import type { ActivityRow, SessionRow } from "@/lib/platform";
import { groupBy } from "@/lib/group";
import { clock } from "@/lib/format";

const icon = (k: string) => (/lock|promot/.test(k) ? "✓" : /veto|reject/.test(k) ? "×" : /conflict|already/.test(k) ? "!" : /^said/.test(k) ? "“" : /·/.test(k) ? "↗" : "•");
const family = (k: string) => (/lock|promot/.test(k) ? "locked" : /veto|reject/.test(k) ? "vetoed" : /conflict|already/.test(k) ? "conflicts" : /^said/.test(k) ? "said" : /·/.test(k) ? "sent" : "other");

export default function Latest({ rows, sessions, n = 6 }: { rows: ActivityRow[]; sessions: SessionRow[]; n?: number }) {
  const meta = new Map(sessions.map((s) => [s.id, s]));
  const pick = rows.filter((r) => !/^agent run|^ask |user login|session categorized|template set|workflow (enabled|disabled)/.test(r.kind));
  const groups = groupBy(pick, (r) => r.callId ?? "workspace").slice(0, n);
  return (
    <ul className="lg">
      {groups.map(([id, evs], gi) => {
        const s = meta.get(id);
        const counts = groupBy(evs, (e) => family(e.kind)).filter(([f]) => f !== "other").map(([f, v]) => `${v.length} ${f}`);
        return (
          <li key={id}>
            <details open={gi === 0}>
              <summary>
                <span className={`sx-dot s-${s?.state ?? "ended"}`} />
                <span className="lg-main"><b>{id === "workspace" ? "Workspace" : s?.title ?? id}</b><span className="muted small">{counts.join(" · ") || `${evs.length} events`}</span></span>
                <time>{clock(evs[0].at)}</time>
                <span className="lg-caret">▾</span>
              </summary>
              <ul className="lt">
                {evs.slice(0, 8).map((r, i) => (
                  <li key={i} className={`lt-${r.tone ?? "n"}`}>
                    <span className="lt-ico">{icon(r.kind)}</span>
                    <span className="lt-main"><b>{r.kind}</b><span>{r.text || r.actor}</span></span>
                    <span />
                    <time>{clock(r.at)}</time>
                  </li>
                ))}
              </ul>
              {id !== "workspace" && <Link href={`/sessions/${encodeURIComponent(id)}`} className="p-more lg-open">Open session →</Link>}
            </details>
          </li>
        );
      })}
      {!groups.length && <li className="muted small">Nothing yet.</li>}
    </ul>
  );
}
