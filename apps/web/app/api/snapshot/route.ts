import { db } from "@/lib/db";
import { loadAll } from "@/lib/snapshot";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const callId = new URL(req.url).searchParams.get("callId");
  if (!callId) return Response.json({ error: "callId required" }, { status: 400 });
  return Response.json(await loadAll(await db(), callId));
}
