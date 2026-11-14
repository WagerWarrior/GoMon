import MissionControl from "@/components/platform/MissionControl";
import { mission } from "@/lib/mission";
export const dynamic = "force-dynamic";
export default async function MissionPage({ searchParams }: { searchParams: Promise<{ callId?: string }> }) {
  return <MissionControl initial={await mission((await searchParams).callId)} />;
}
