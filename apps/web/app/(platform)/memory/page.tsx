import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import { memories } from "@/lib/platform";
import { when } from "@/lib/format";
export const dynamic = "force-dynamic";

export default async function Memory({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const all = await memories(); const status = (await searchParams).status ?? "active";
  const rows = status === "all" ? all : all.filter((m) => (m.status ?? "active") === status);
  const n = (s: string) => all.filter((m) => (m.status ?? "active") === s).length;
  return (
    <>
      <AutoRefresh ms={8000} />
      <header className="p-head">
        <div><span className="eyebrow">Governed team memory · Atlas memories</span><h1>Memory</h1></div>
        <div className="pills">{[["active", n("active")], ["superseded", n("superseded")], ["forgotten", n("forgotten")], ["all", all.length]].map(([k, c]) => <Link key={k} href={`/memory?status=${k}`} className="chip" aria-pressed={status === k}>{k} {c}</Link>)}</div>
      </header>
      <section className="p-card p-flush">
        <table className="p-table">
          <thead><tr><th>Key</th><th>Kind</th><th>What the team holds</th><th>Version</th><th>Source</th><th>Locked by</th><th>Updated</th></tr></thead>
          <tbody>
            {rows.map((m) => {
              const call = (m.sourceRefs ?? []).find((r: any) => r.type === "call");
              return (
                <tr key={m._id} data-muted={m.status !== "active" ? "1" : undefined}>
                  <td className="mono"><b>{m.key ?? "—"}</b></td>
                  <td><span className="kind">{String(m.kind).replace(/_/g, " ")}</span></td>
                  <td className="p-wide">{m.text}{m.status !== "active" && <span className="pill"> {m.status}</span>}</td>
                  <td className="mono">v{m.version ?? 1}</td>
                  <td>{call ? <Link href={`/sessions/${encodeURIComponent(call.callId)}?tab=decisions`}>{call.callId}</Link> : <span className="muted">{m.origin ?? "—"}</span>}</td>
                  <td className="small">{m.lock?.participants?.join(", ") ?? m.lock?.lockedBy ?? "—"}</td>
                  <td className="small muted">{when(m.updatedAt ?? m.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <div className="p-empty">Nothing here.</div>}
      </section>
    </>
  );
}
