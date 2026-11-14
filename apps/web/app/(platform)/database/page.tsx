import { database } from "@/lib/platform";
export const dynamic = "force-dynamic";

export default async function Database() {
  const d = await database();
  const total = d.rows.reduce((a, r) => a + r.count, 0);
  return (
    <>
      <header className="p-head"><div><span className="eyebrow">MongoDB Atlas · {d.db} · {d.rows.length} collections · {total} documents</span><h1>Database</h1></div></header>
      <section className="p-dbgrid">
        {d.rows.map((r) => (
          <details key={r.name} className="p-card p-db">
            <summary>
              <span className="mono"><b>{r.name}</b></span>
              <span className="p-db-n">{r.count}</span>
              <span className="muted small">{r.indexes.length} index{r.indexes.length === 1 ? "" : "es"}{r.search.length ? ` · ${r.search.join(", ")}` : ""}</span>
            </summary>
            <div className="p-db-fields">{r.fields.map((f) => <code key={f}>{f}</code>)}</div>
            {r.sample && <pre className="p-db-sample">{r.sample}</pre>}
          </details>
        ))}
      </section>
    </>
  );
}
