import { overview, session, sessions } from "@/lib/platform";
import { dur } from "@/lib/format";
import { cacheStats } from "@/lib/db";
export const dynamic = "force-dynamic";

/**
 * Ask Gomon dock commands that answer from Atlas facts only (no model, nothing invented):
 *  - status: what is live, reliability, anything failing
 *  - summarize: one session (the one on screen, else the latest live, else the latest), from its own rows
 * Free questions go to /api/ask (memory-grounded answer).
 */
type Reply = { title: string; lines: string[]; links: { label: string; href: string }[] };

export async function POST(req: Request) {
  const { cmd, callId } = (await req.json().catch(() => ({}))) as { cmd?: string; callId?: string };
  if (cmd === "status") return Response.json(await status());
  if (cmd === "summarize") return Response.json(await summarize(callId));
  return Response.json({ error: "cmd must be status or summarize" }, { status: 400 });
}

async function status(): Promise<Reply> {
  const o = await overview(); const r = o.reliability;
  const live = o.sessions.filter((s: any) => s.state === "live");
  const failed = o.sessions.filter((s: any) => s.state === "failed");
  return {
    title: live.length ? `${live.length} live session${live.length === 1 ? "" : "s"}` : "No live sessions",
    lines: [
      ...live.slice(0, 4).map((s: any) => `● ${s.title} · ${s.utterances} heard · ${s.locked} locked`),
      `Processed ${r.pipeline ?? "—"}% of utterances, ${r.within10s ?? "—"}% within 10 s.`,
      `Bot joined ${r.botJoinRate ?? "—"}% of sessions. Sends delivered ${r.sends ?? "—"}% (${r.sendsOk}/${r.sendsTotal}).`,
      failed.length ? `${failed.length} failed session${failed.length === 1 ? "" : "s"}: ${failed.slice(0, 3).map((s: any) => s.title).join(", ")}` : "No failed sessions.",
    ],
    links: [...live.slice(0, 3).map((s: any) => ({ label: `Open ${s.title}`, href: `/sessions/${encodeURIComponent(s.id)}?tab=live` })), { label: "Mission control", href: "/" }],
  };
}

async function summarize(want?: string): Promise<Reply> {
  const list = await sessions();
  const pick = (want && list.find((s) => s.id === want)) || list.find((s) => s.state === "live") || list[0];
  if (!pick) return { title: "No sessions yet", lines: [], links: [] };
  const s = await session(pick.id);
  const speakers = new Map<string, number>();
  for (const u of s.utterances) { const n = u.speaker?.displayName ?? "?"; speakers.set(n, (speakers.get(n) ?? 0) + 1); }
  const locked = s.items.filter((i: any) => i.status === "promoted");
  const open = s.items.filter((i: any) => !["promoted", "rejected"].includes(i.status));
  const last = s.utterances.slice(-2);
  return {
    title: pick.title,
    lines: [
      `${pick.category} · ${pick.state} · ${dur(s.row?.durationMs)} · ${s.utterances.length} turns`,
      `Spoke: ${[...speakers.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`).join(", ") || "nobody yet"}`,
      ...(locked.length ? locked.slice(0, 4).map((i: any) => `✓ Locked: ${i.text}`) : ["Nothing locked yet."]),
      ...open.slice(0, 3).map((i: any) => `○ Open ${String(i.kind).replace(/_/g, " ")}: ${i.text}`),
      ...(s.conflicts.length ? [`⚠ ${s.conflicts.length} conflict${s.conflicts.length === 1 ? "" : "s"} with past decisions`] : []),
      ...last.map((u: any) => `“${u.text}” (${u.speaker?.displayName ?? "?"})`),
    ],
    links: [{ label: "Open session", href: `/sessions/${encodeURIComponent(pick.id)}` }, { label: "Workflows & events", href: `/sessions/${encodeURIComponent(pick.id)}?tab=events` }],
  };
}

/** Context for the dock: sessions to pick from (live first), memory size, and how fresh the cache is. */
export async function GET() {
  const [list, o] = await Promise.all([sessions(), overview()]);
  const c = cacheStats();
  return Response.json({
    sessions: [...list.filter((s) => s.state === "live"), ...list.filter((s) => s.state !== "live")].slice(0, 30).map((s) => ({ id: s.id, title: s.title, state: s.state })),
    memories: o.kpi.memories, cache: { views: c.length, newestMs: c.length ? Math.min(...c.map((x) => x.ageMs)) : null },
  });
}
