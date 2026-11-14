import { redirect } from "next/navigation";
import { db, scope } from "@/lib/db";
export const dynamic = "force-dynamic";

export default async function Home() {
  const d = await db(); const { teamId, projectId } = scope();
  const latest = await d.collection("calls").find({ teamId, projectId }).sort({ startedAt: -1, _id: -1 }).limit(1).next();
  if (latest) redirect(`/calls/${encodeURIComponent(String(latest._id))}`);
  return (
    <main className="empty-home"><h1>Gomon workspace</h1>
      <p>No calls yet for <code>{teamId}</code> / <code>{projectId}</code>. Start a call with the bot, or load the labeled synthetic dev data:</p>
      <pre>npm run seed:dev</pre></main>
  );
}
