import Link from "next/link";
import AutoRefresh from "@/components/platform/AutoRefresh";
import { NewProject } from "@/components/platform/Projects";
import { people, projects, type ProjectRow } from "@/lib/projects";
import { when } from "@/lib/format";
export const dynamic = "force-dynamic";

/** Projects: company context (read by every call) on top, then the working projects calls are started in. */
export default async function ProjectsPage() {
  const [rows, who] = await Promise.all([projects(), people()]);
  const company = rows.find((p) => p.company);
  const working = rows.filter((p) => !p.company);
  return (
    <>
      <AutoRefresh ms={8000} />
      <header className="p-head">
        <div><h1>Projects</h1><span className="eyebrow">{working.length} project{working.length === 1 ? "" : "s"} · every call reads its project plus company context</span></div>
        <Link href="/start" className="btn blue sm">Start meeting</Link>
      </header>
      {company && (
        <section className="p-card pj-company">
          <div className="p-card-h"><h2>{company.name}</h2><span className="pill">read by every call</span></div>
          {company.description && <p className="tp-desc">{company.description}</p>}
          <dl className="tp-facts pj-facts">
            <div><dt>Memories</dt><dd><Link href={`/memory?project=${encodeURIComponent(company._id)}`}>{company.memories}</Link></dd></div>
            <div><dt>Read by</dt><dd>{working.length} project{working.length === 1 ? "" : "s"}</dd></div>
            <div><dt>Project id</dt><dd className="mono">{company._id}</dd></div>
          </dl>
        </section>
      )}
      <section className="tp-grid">
        {working.map((p) => <ProjectCard key={p._id} p={p} />)}
        <NewProject people={who} />
      </section>
    </>
  );
}

function ProjectCard({ p }: { p: ProjectRow }) {
  return (
    <article className="p-card tp-card">
      <div className="p-card-h"><h2>{p.name}</h2><span className="muted small mono">{p._id}</span></div>
      {p.description && <p className="tp-desc">{p.description}</p>}
      <dl className="tp-facts pj-facts">
        <div><dt>Sessions</dt><dd><Link href={`/sessions?project=${encodeURIComponent(p._id)}`}>{p.calls}</Link></dd></div>
        <div><dt>Memories</dt><dd><Link href={`/memory?project=${encodeURIComponent(p._id)}`}>{p.memories}</Link></dd></div>
        <div><dt>Last call</dt><dd>{when(p.lastCallAt)}</dd></div>
      </dl>
      <div className="btns">
        <Link href={`/start?project=${encodeURIComponent(p._id)}`} className="btn sm">Start meeting</Link>
        {p.github?.url ? <a href={p.github.url} target="_blank" rel="noreferrer" className="btn sm">GitHub board{p.github.projectNumber ? ` #${p.github.projectNumber}` : ""}</a> : <span className="muted small pj-noboard">No GitHub board yet</span>}
      </div>
      {(p.createdBy || p.synthetic) && <p className="muted small">{p.createdBy ? `Created by ${p.createdBy}` : ""}{p.synthetic ? `${p.createdBy ? " · " : ""}synthetic seed` : ""}</p>}
    </article>
  );
}
