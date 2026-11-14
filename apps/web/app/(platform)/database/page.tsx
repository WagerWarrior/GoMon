import Link from "next/link";
import { database } from "@/lib/platform";
import { DB_GROUPS, USED_BY } from "@/lib/dbmap";
import { cacheStats } from "@/lib/db";
export const dynamic = "force-dynamic";

export default async function Database() {
  const d = await database(); const cache = cacheStats();
  const groupOf = (k: string) => k.split(":")[0];
  const cg = Object.entries(cache.reduce((a: Record<string, { n: number; hits: number; fresh: number; age: number }>, c) => { const g = (a[groupOf(c.key)] ??= { n: 0, hits: 0, fresh: 0, age: Infinity }); g.n++; g.hits += c.hits; g.fresh += c.fresh ? 1 : 0; g.age = Math.min(g.age, c.ageMs); return a; }, {}));
  const count = new Map(d.rows.map((r) => [r.name, r]));
  const grouped = new Set(DB_GROUPS.flatMap((g) => g.colls));
  const other = d.rows.filter((r) => !grouped.has(r.name)).map((r) => r.name);
  const groups = [...DB_GROUPS, ...(other.length ? [{ group: "Other", colls: other }] : [])];
  return (
    <>
      <header className="p-head"><div><h1>Database</h1><span className="eyebrow">MongoDB Atlas · {d.db} · {d.rows.reduce((a, r) => a + r.count, 0)} documents</span></div></header>
      <section className="p-card p-flush">
        <div className="p-card-h mx-pad"><h2>Read cache</h2><span className="muted small">this web server keeps short-lived copies of Atlas views so pages and polls cost one trip</span></div>
        <table className="p-table">
          <thead><tr><th>View</th><th className="num">Copies</th><th className="num">Fresh</th><th className="num">Reads served</th><th className="num">Newest</th></tr></thead>
          <tbody>{cg.map(([k, g]) => <tr key={k}><td className="mono">{k}</td><td className="num">{g.n}</td><td className="num">{g.fresh}</td><td className="num">{g.hits}</td><td className="num mono">{g.age < 1000 ? `${g.age} ms` : `${Math.round(g.age / 1000)} s`}</td></tr>)}</tbody>
        </table>
      </section>
      {groups.map((g) => (
        <section key={g.group} className="p-card p-flush">
          <div className="p-card-h mx-pad"><h2>{g.group}</h2>{g.group === "Memory" && <Link href="/memory" className="p-more">Memory view</Link>}</div>
          <table className="p-table">
            <thead><tr><th>Collection</th><th className="num">Documents</th><th>Written by</th><th>Read by</th><th>Indexes</th></tr></thead>
            <tbody>{g.colls.filter((c) => count.has(c)).map((c) => {
              const r = count.get(c)!; const u = USED_BY[c];
              return (
                <tr key={c}>
                  <td><Link href={`/database/${c}`} className="p-rowlink mono">{c}</Link>{u?.note && <span className="muted small p-id db-note">{u.note}</span>}</td>
                  <td className="num">{r.count}</td><td className="small">{u?.writes.join(", ") ?? "—"}</td><td className="small">{u?.reads.join(", ") ?? "—"}</td>
                  <td className="small muted">{r.indexes.length}{r.search.length ? ` · ${r.search.length} search` : ""}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </section>
      ))}
    </>
  );
}
