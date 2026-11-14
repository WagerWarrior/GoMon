import Link from "next/link";
import { LeaveMeeting, StartMeeting } from "@/components/platform/Meetings";
import { botCalls, people, projectNames, projects } from "@/lib/projects";
import { templates } from "@/lib/templates";
import { scope } from "@/lib/db";
import { when } from "@/lib/format";
export const dynamic = "force-dynamic";

/** Start a meeting from the workspace: Gomon joins the Meet through Recall in one project. Also lists meetings it is in now. */
export default async function StartPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const [rows, tpl, who, inMeetings, names] = await Promise.all([projects(), templates(), people(), botCalls(), projectNames()]);
  const working = rows.filter((p) => !p.company).map((p) => ({ id: p._id, name: p.name }));
  const fallback = scope().projectId;
  // An install without a projects row for PROJECT_ID still has its legacy calls there; offer it so the form is never empty.
  const options = working.length ? working : [{ id: fallback, name: fallback }];
  const wanted = (await searchParams).project;
  const project = options.find((p) => p.id === wanted)?.id ?? options.find((p) => p.id === fallback)?.id ?? options[0].id;
  const tplOptions = (tpl.rows as { _id: string; name: string }[]).map((t) => ({ id: t._id, name: t.name }));
  return (
    <>
      <header className="p-head">
        <div><h1>Start a meeting</h1><span className="eyebrow">Gomon joins your Google Meet, listens, and keeps the project&apos;s memory</span></div>
        <Link href="/projects" className="p-more">Projects</Link>
      </header>
      <section className="p-row p-row-2-1">
        <StartMeeting projects={options} templates={tplOptions} people={who} defaults={{ project, template: tplOptions.find((t) => t.id === "design-review")?.id ?? tplOptions[0]?.id ?? "" }} />
        <div className="p-card">
          <div className="p-card-h"><h2>Gomon is in</h2><span className="muted small">{inMeetings.length ? `${inMeetings.length} meeting${inMeetings.length > 1 ? "s" : ""}` : "no meetings"}</span></div>
          <ul className="ws-list mt-list">
            {inMeetings.map((m) => (
              <li key={m.id}>
                <div className="row"><Link href={`/sessions/${encodeURIComponent(m.id)}?tab=live`}><b>{m.title}</b></Link><span className="muted small">{when(m.startedAt)}</span></div>
                <p className="muted small">{names.get(m.projectId) ?? m.projectId}{m.meetingUrl ? <> · <a href={m.meetingUrl} target="_blank" rel="noreferrer">meeting link</a></> : null}</p>
                <LeaveMeeting callId={m.id} />
              </li>
            ))}
          </ul>
          {!inMeetings.length && <div className="p-empty">Start one on the left.</div>}
        </div>
      </section>
    </>
  );
}
