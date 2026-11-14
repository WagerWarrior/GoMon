import Link from "next/link";
import { database } from "@/lib/platform";
import { DB_GROUPS, USED_BY } from "@/lib/dbmap";
export const dynamic = "force-dynamic";

export default async function Database() {
  const d = await database();
  const count = new Map(d.rows.map((r) => [r.name, r]));
  const grouped = new Set(DB_GROUPS.flatMap((g) => g.colls));
  const other = d.rows.filter((r) => !grouped.has(r.name)).map((r) => r.name);
  const groups = [...DB_GROUPS, ...(other.length ? [{ group: "Other", colls: other }] : [])];
  return (
    <>
      <header className="p-head"><div><h1>Database</h1><span className="eyebrow">MongoDB Atlas · {d.db} · {d.rows.reduce((a, r) => a + r.count, 0)} documents</span></div></header>
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
