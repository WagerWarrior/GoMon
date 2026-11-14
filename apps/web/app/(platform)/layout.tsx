import "./platform.css";
import Sidebar from "@/components/platform/Sidebar";
import { db, scope } from "@/lib/db";
export const dynamic = "force-dynamic";

// Sidebar facts change rarely; cache them for a few seconds so every navigation and refresh skips two Atlas round trips.
const g = globalThis as unknown as { __side?: { at: number; team: string; live: number } };
async function sideFacts() {
  if (g.__side && Date.now() - g.__side.at < 10_000) return g.__side;
  const d = await db(); const { teamId, projectId } = scope();
  const [team, live] = await Promise.all([d.collection("teams").findOne({ _id: teamId as any }), d.collection("calls").countDocuments({ teamId, projectId, status: "live" })]);
  return (g.__side = { at: Date.now(), team: team?.name ?? teamId, live });
}

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const { team, live } = await sideFacts();
  return (
    <div className="p-app">
      <Sidebar team={team} live={live} />
      <main className="p-main">{children}</main>
    </div>
  );
}
