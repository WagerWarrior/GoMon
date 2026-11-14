import { db } from "@/lib/db";
import { PANELS, loadAll, loadPanel, type Panel } from "@/lib/snapshot";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Live updates: a snapshot, then per-collection re-reads whenever Atlas reports a change (change streams).
 * If change streams are unavailable (standalone mongod) it falls back to polling and says so in the first event.
 * Atlas stays the only source of truth: this route holds no state besides which panels are dirty.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("callId");
  if (!q) return new Response("callId required", { status: 400 });
  const callId: string = q;
  const d = await db();
  const enc = new TextEncoder();
  let closed = false;
  const cleanup: (() => void)[] = [];

  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (event: string, data: unknown) => { if (!closed) ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); };
      const dirty = new Set<Panel>();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = async () => {
        timer = null;
        const panels = [...dirty]; dirty.clear();
        for (const p of panels) { try { send("panel", { panel: p, docs: await loadPanel(d, p, callId) }); } catch (e) { send("error", String(e)); } }
      };
      const mark = (p: Panel) => { dirty.add(p); if (!timer) timer = setTimeout(flush, 120); };

      let mode: "change-stream" | "polling" = "change-stream";
      try {
        const cs = d.watch([{ $match: { "ns.coll": { $in: [...PANELS] } } }], { fullDocument: "updateLookup" });
        cleanup.push(() => { void cs.close(); });
        cs.on("change", (ev: any) => mark(ev.ns?.coll as Panel));
        cs.on("error", () => { if (!closed) send("mode", { mode: "polling", reason: "change stream error" }); startPolling(); });
        await new Promise((res, rej) => { cs.once("init" as any, res); setTimeout(res, 400); cs.once("error", rej); }).catch(() => { throw new Error("watch failed"); });
      } catch { mode = "polling"; startPolling(); }

      function startPolling() {
        if (cleanup.length > 8) return;
        const last = new Map<Panel, string>();
        const iv = setInterval(async () => {
          for (const p of PANELS) { const s = JSON.stringify(await loadPanel(d, p, callId)); if (last.get(p) !== undefined && last.get(p) !== s) mark(p); last.set(p, s); }
        }, 1000);
        cleanup.push(() => clearInterval(iv));
      }

      send("mode", { mode });
      send("snapshot", await loadAll(d, callId));
      const ka = setInterval(() => { if (!closed) ctrl.enqueue(enc.encode(": keep-alive\n\n")); }, 15000);
      cleanup.push(() => clearInterval(ka));
      req.signal.addEventListener("abort", () => { closed = true; cleanup.forEach((f) => f()); try { ctrl.close(); } catch {} });
    },
    cancel() { closed = true; cleanup.forEach((f) => f()); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive" } });
}
