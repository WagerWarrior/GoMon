import "./platform.css";
import Sidebar from "@/components/platform/Sidebar";
import { db, scope } from "@/lib/db";
export const dynamic = "force-dynamic";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const d = await db(); const { teamId, projectId } = scope();
  const [team, live] = await Promise.all([d.collection("teams").findOne({ _id: teamId as any }), d.collection("calls").countDocuments({ teamId, projectId, status: "live" })]);
  return (
    <div className="p-app">
      <Sidebar team={team?.name ?? teamId} live={live} />
      <main className="p-main">{children}</main>
    </div>
  );
}
