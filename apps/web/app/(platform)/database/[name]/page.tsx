import Link from "next/link";
import { collection } from "@/lib/platform";
import { USED_BY } from "@/lib/dbmap";
import DocTable from "@/components/platform/DocTable";
export const dynamic = "force-dynamic";

export default async function CollectionPage({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const c = await collection(name); const u = USED_BY[name];
  const cols = c.fields.filter((f: any) => f.name !== "_id" && f.presence >= 50).slice(0, 6).map((f: any) => f.name);
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
            <tbody>{c.fields.slice(0, 10).map((f: any) => <Field key={f.name} f={f} />)}</tbody></table>
          {c.fields.length > 10 && <details className="db-more"><summary>Show all {c.fields.length} fields</summary><table className="p-table"><tbody>{c.fields.slice(10).map((f: any) => <Field key={f.name} f={f} />)}</tbody></table></details>}
        </div>
      </section>
      <section className="p-card p-flush">
        <div className="p-card-h mx-pad"><h2>Latest documents</h2><span className="muted small">click a row to preview</span></div>
        <DocTable name={name} docs={c.docs} cols={cols} />
      </section>
    </>
  );
}

function Field({ f }: { f: any }) {
  return <tr><td className="mono">{f.name}</td><td className="small muted">{f.types.join(" | ")}</td><td className="num"><span className="db-bar"><i style={{ width: `${f.presence}%` }} /></span>{f.presence}%</td></tr>;
}
