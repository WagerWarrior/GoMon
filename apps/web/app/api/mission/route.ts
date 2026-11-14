import { mission } from "@/lib/mission";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const callId = new URL(req.url).searchParams.get("callId") || undefined;
  return Response.json(await mission(callId), { headers: { "cache-control": "no-store" } });
}
