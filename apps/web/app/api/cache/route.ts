import { cacheStats } from "@/lib/db";
export const dynamic = "force-dynamic";
/** The web server's read cache: which Atlas views are held, how old, how many reads each served. */
export async function GET() { return Response.json({ now: new Date().toISOString(), entries: cacheStats() }); }
