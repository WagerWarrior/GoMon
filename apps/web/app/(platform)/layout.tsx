import "./platform.css";
import Sidebar from "@/components/platform/Sidebar";
import AskDock from "@/components/platform/AskDock";
import { cached, db, scope } from "@/lib/db";
import { sessions } from "@/lib/platform";
export const dynamic = "force-dynamic";

async function sideFacts() {
  return cached("side", 5000, async () => {
    const d = await db(); const { teamId } = scope();
    const [team, rows] = await Promise.all([d.collection("teams").findOne({ _id: teamId as any }), sessions()]);
    return { team: team?.name ?? teamId, live: rows.filter((r) => r.state === "live").map((r) => ({ id: r.id, title: r.title })) };
  });
}

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const { team, live } = await sideFacts();
  return (
    <div className="p-app">
      <Sidebar team={team} live={live} />
      <main className="p-main">{children}</main>
      <AskDock />
    </div>
  );
}
