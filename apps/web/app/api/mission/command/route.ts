import { command } from "@/lib/mission";
export const dynamic = "force-dynamic";
/** Operator commands from mission control: { callId, mode: "prompt" | "say", text }. Both are plain Atlas writes. */
export async function POST(req: Request) {
  const r = await command(await req.json().catch(() => ({})));
  return Response.json(r.data, { status: r.status });
}
