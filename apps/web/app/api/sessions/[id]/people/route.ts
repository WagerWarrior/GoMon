import { db, scope } from "@/lib/db";
import { peopleChoices } from "@/lib/people";
export const dynamic = "force-dynamic";

/** Who is in the Meet now and the names the listener offers (polled by Listen while it is not running). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await db(); const { teamId } = scope();
  const [call, members] = await Promise.all([
    d.collection("calls").findOne({ _id: decodeURIComponent(id) as any }, { projection: { liveParticipants: 1, participants: 1 } }),
    d.collection("members").find({ teamId }).project({ displayName: 1 }).toArray(),
  ]);
  return Response.json(peopleChoices(call as any, members.map((m) => String(m.displayName ?? ""))));
}
