/**
 * The after-call recap on an ended session: counts, the prose lead, one block per section, and where it went
 * (the GitHub record on gomon-records, the Slack thread). Server component; `strip` renders the folded Live-tab bar.
 */
import Link from "next/link";
import { inline, parseRecap } from "@/lib/mrkdwn";
import { countChips, type RecapView, type Out } from "@/lib/recap";
import { when } from "@/lib/format";

function Text({ s }: { s: string }) {
  return <>{inline(s).map((g, i) => g.t === "url" ? <a key={i} href={g.v} target="_blank" rel="noreferrer">{g.label}</a>
    : g.t === "key" ? <Link key={i} href={`/database/memories?key=${encodeURIComponent(g.v)}`} className="rc-key">{g.v}</Link>
    : g.t === "b" ? <b key={i}>{g.v}</b> : <span key={i}>{g.v}</span>)}</>;
}

function Dest({ label, o, pending }: { label: string; o: Out | null; pending: string }) {
  if (!o) return <span className="rc-dest off" title={pending}><i />{label}: not queued</span>;
  const state = o.url ? "sent" : o.status === "failed" ? "failed" : o.status;
  const el = <span className={`rc-dest s-${state}`} title={o.error ?? o.path ?? ""}><i />{label}{o.url ? " ↗" : `: ${state}`}</span>;
  return o.url ? <a href={o.url} target="_blank" rel="noreferrer" className="rc-link">{el}</a> : el;
}

export default function RecapCard({ v, ended, strip }: { v: RecapView; ended: boolean; strip?: boolean }) {
  if (!ended) return null;
  if (!v.recap) {
    return strip ? null : <section className="p-card rc rc-wait"><div className="p-card-h"><h2>After-call recap</h2><span className="muted small">not written yet</span></div><p className="muted small">Gomon writes the recap from the governed record within a minute of a call ending: decisions locked with keys, tasks, memory changes, open items and what was filed. Calls that ended more than 6 hours before the connectors ran are not back-filled.</p></section>;
  }
  const r = parseRecap(v.recap.text); const chips = countChips(v.recap.counts);
  const dests = <span className="rc-dests"><Dest label="Record on GitHub" o={v.record} pending="Filed when a participant may write to GitHub" /><Dest label="Slack thread" o={v.slack} pending={v.recap.note ?? "Posted when a participant may post to Slack"} /></span>;
  const body = (
    <div className="rc-body">
      {r.lead.map((l, i) => <p key={i} className="rc-lead"><Text s={l} /></p>)}
      <div className="rc-grid">
        {r.sections.map((s) => (
          <div key={s.title} className="rc-sec">
            <h3>{s.title}<span>{s.items.length}</span></h3>
            <ul>{s.items.map((it, i) => <li key={i}><Text s={it} /></li>)}</ul>
          </div>
        ))}
      </div>
      {r.tail.filter((l) => !/^Full session:/.test(l)).map((l, i) => <p key={i} className="muted small"><Text s={l} /></p>)}
    </div>
  );
  if (strip) {
    return (
      <details className="rc-strip">
        <summary><span className="rc-badge">Recap</span><b>{chips.join(" · ") || "No decisions locked"}</b>{dests}<span className="rc-caret">▾</span></summary>
        {body}
      </details>
    );
  }
  return (
    <section className="p-card rc" id="recap">
      <div className="rc-h">
        <div><span className="eyebrow">After-call recap · {when(v.recap.at)}</span><h2>{r.title.replace(/^Recap:\s*/, "")}</h2>{r.sub && <span className="muted small">{r.sub}</span>}</div>
        {dests}
      </div>
      {chips.length > 0 && <div className="rc-chips">{chips.map((c) => <span key={c}>{c}</span>)}</div>}
      {body}
    </section>
  );
}
