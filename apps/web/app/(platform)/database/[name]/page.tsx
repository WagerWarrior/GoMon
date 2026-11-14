import Link from "next/link";
import { collection } from "@/lib/platform";
import { USED_BY } from "@/lib/dbmap";
export const dynamic = "force-dynamic";

export default async function CollectionPage({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const c = await collection(name); const u = USED_BY[name];
  const cols = c.fields.filter((f: any) => f.name !== "_id" && f.presence >= 50).slice(0, 6).map((f: any) => f.name);
  const show = (v: unknown) => { if (v == null) return "—"; const s = typeof v === "object" ? JSON.stringify(v) : String(v); return s.length > 90 ? s.slice(0, 89) + "…" : s; };
  return (
    <>
      <header className="p-head">
        <div><span className="eyebrow"><Link href="/database">Database</Link> / {name}</span><h1 className="mono-h">{name}</h1>{u?.note && <span className="eyebrow">{u.note}</span>}</div>
        {name === "memories" && <Link href="/memory" className="btn sm">Memory view</Link>}
      </header>
      <section className="p-kpis p-kpis-4">
        <div className="p-kpi"><span className="eyebrow">Documents</span><b>{c.count}</b></div>
        <div className="p-kpi"><span className="eyebrow">Fields</span><b>{c.fields.length}</b></div>
        <div className="p-kpi"><span className="eyebrow">Indexes</span><b>{c.indexes.length}</b></div>
        <div className="p-kpi"><span className="eyebrow">Search indexes</span><b>{c.search.length}</b></div>
      </section>
      <section className="p-row p-row-1-1">
        <div className="p-card">
          <div className="p-card-h"><h2>Connected to</h2></div>
          <dl className="db-use"><dt>Written by</dt><dd>{u?.writes.join(" · ") ?? "—"}</dd><dt>Read by</dt><dd>{u?.reads.join(" · ") ?? "—"}</dd></dl>
          <div className="p-card-h db-gap"><h2>Indexes</h2></div>
          <ul className="db-idx">
            {c.indexes.map((i: any) => <li key={i.name}><code>{i.name}</code><span className="muted small">{Object.entries(i.key).map(([k, v]) => `${k}:${v}`).join(", ")}{i.unique ? " · unique" : ""}{i.ttl != null ? ` · TTL ${i.ttl}s` : ""}</span></li>)}
            {c.search.map((s: string) => <li key={s}><code>{s}</code><span className="muted small">Atlas Search</span></li>)}
          </ul>
        </div>
        <div className="p-card p-flush">
          <div className="p-card-h mx-pad"><h2>Fields</h2><span className="muted small">latest 200 documents</span></div>
          <table className="p-table"><thead><tr><th>Field</th><th>Type</th><th className="num">Present</th></tr></thead>
            <tbody>{c.fields.map((f: any) => <tr key={f.name}><td className="mono">{f.name}</td><td className="small muted">{f.types.join(" | ")}</td><td className="num">{f.presence}%</td></tr>)}</tbody></table>
        </div>
      </section>
      <section className="p-card p-flush">
        <div className="p-card-h mx-pad"><h2>Latest documents</h2></div>
        <table className="p-table">
          <thead><tr><th>_id</th>{cols.map((k: string) => <th key={k}>{k}</th>)}<th></th></tr></thead>
          <tbody>{c.docs.map((d: any) => (
            <tr key={String(d._id)}>
              <td className="mono small">{show(d._id)}</td>{cols.map((k: string) => <td key={k} className="small">{show(d[k])}</td>)}
              <td><details className="db-json"><summary>JSON</summary><pre>{JSON.stringify(d, null, 2)}</pre></details></td>
            </tr>
          ))}</tbody>
        </table>
      </section>
    </>
  );
}
