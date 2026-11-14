import { endMeeting } from "@/lib/mission";
export const dynamic = "force-dynamic";
/** End this meeting now: the call is ended in Atlas, Gomon stops talking and leaves (lib/mission.ts endMeeting). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const b = (await req.json().catch(() => ({}))) as { actor?: string };
  const r = await endMeeting({ callId: decodeURIComponent((await params).id), actor: b.actor });
  return Response.json(r.data, { status: r.status });
}
