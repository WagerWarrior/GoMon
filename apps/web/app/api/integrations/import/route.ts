import { readFile, writeFile } from "node:fs/promises";
import { mergeEnv, parseEnv } from "@/lib/envfile";
import { setup } from "@/lib/platform";
export const dynamic = "force-dynamic";

/**
 * Import keys into the repo-root .env from pasted KEY=value lines (Integrations page).
 * Local only: refused unless the request comes to localhost. Only keys a known integration uses are written.
 * The response names the keys that were set, never their values. Other services (worker, bot page) pick them up on restart.
 */
export async function POST(req: Request) {
  // Next fills x-forwarded-for with the real client address; every hop must be this machine.
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  const loop = (a: string) => ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(a.trim());
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").filter((x) => x.trim());
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host) || !hops.every(loop)) return Response.json({ error: "Import only works on this computer (localhost)." }, { status: 403 });
  const { text } = (await req.json().catch(() => ({}))) as { text?: string };
  const pasted = parseEnv(text ?? "");
  const known = new Set(setup().flatMap((s) => s.keys.map((k) => k.k)));
  const set = Object.fromEntries(Object.entries(pasted).filter(([k]) => known.has(k)));
  const skipped = Object.keys(pasted).filter((k) => !known.has(k));
  if (!Object.keys(set).length) return Response.json({ error: "No known keys found. Paste lines like SLACK_BOT_TOKEN=xoxb-…", skipped }, { status: 400 });
  const path = `${process.cwd()}/../../.env`;
  const before = await readFile(path, "utf8").catch(() => "");
  await writeFile(path, mergeEnv(before, set), { mode: 0o600 });
  for (const [k, v] of Object.entries(set)) process.env[k] = v;
  return Response.json({ set: Object.keys(set), skipped });
}
