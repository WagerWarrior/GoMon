import { redirect } from "next/navigation";
/** Mission control is the home page now; a single call's live view is under its session. */
export default async function MissionPage({ searchParams }: { searchParams: Promise<{ callId?: string }> }) {
  const id = (await searchParams).callId;
  redirect(id ? `/sessions/${encodeURIComponent(id)}?tab=live` : "/");
}
