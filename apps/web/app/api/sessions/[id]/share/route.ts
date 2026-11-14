import { shareLink } from "@/lib/mission";
export const dynamic = "force-dynamic";
/** Send a link Gomon filed (GitHub issue, Slack post, call record) into this call's meeting chat (lib/mission.ts shareLink). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const b = (await req.json().catch(() => ({}))) as { url?: string; label?: string; actor?: string };
  const r = await shareLink({ callId: decodeURIComponent((await params).id), url: b.url, label: b.label, actor: b.actor });
  return Response.json(r.data, { status: r.status });
}
