import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import { memories } from "@/lib/platform";
import { when } from "@/lib/format";
import { COMPANY_PROJECT } from "@/lib/scope";
export const dynamic = "force-dynamic";

/** Company context (read by every call) and each project's own memory, labeled and filterable by project. */
export default async function Memory({ searchParams }: { searchParams: Promise<{ status?: string; project?: string }> }) {
  const sp = await searchParams; const status = sp.status ?? "active";
  const team = await memories();
  const scopes = [...new Map(team.map((m) => [m.projectId as string, m.projectName as string])).entries()].sort(([a], [b]) => (a === COMPANY_PROJECT ? -1 : b === COMPANY_PROJECT ? 1 : a.localeCompare(b)));
  const all = sp.project ? team.filter((m) => m.projectId === sp.project) : team;
  const rows = status === "all" ? all : all.filter((m) => (m.status ?? "active") === status);
  const n = (s: string) => all.filter((m) => (m.status ?? "active") === s).length;
  const href = (s: string, p?: string) => `/memory?status=${s}${p ? `&project=${encodeURIComponent(p)}` : ""}`;
  return (
    <>
      <AutoRefresh ms={8000} />
      <header className="p-head">
        <div><h1>Memory</h1></div>
        <div className="pills">{[["active", n("active")], ["superseded", n("superseded")], ["forgotten", n("forgotten")], ["all", all.length]].map(([k, c]) => <Link key={k} href={href(String(k), sp.project)} className="chip" aria-pressed={status === k}>{k} {c}</Link>)}</div>
      </header>
      {scopes.length > 1 && (
        <div className="pills mm-scopes">
          <Link href={href(status)} className="chip" aria-pressed={!sp.project}>All projects</Link>
          {scopes.map(([id, name]) => <Link key={id} href={href(status, id)} className="chip" aria-pressed={sp.project === id}>{name}</Link>)}
        </div>
      )}
      <section className="p-card p-flush">
        <table className="p-table">
          <thead><tr><th>Key</th><th>Project</th><th>Kind</th><th>What the team holds</th><th>Version</th><th>Source</th><th>Locked by</th><th>Updated</th></tr></thead>
          <tbody>
            {rows.map((m) => {
              const call = (m.sourceRefs ?? []).find((r: any) => r.type === "call");
              return (
                <tr key={m._id} data-muted={m.status !== "active" ? "1" : undefined}>
                  <td className="mono"><b>{m.key ?? "—"}</b></td>
                  <td className="small">{m.projectId === COMPANY_PROJECT ? <span className="pill">company</span> : m.projectName}</td>
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
