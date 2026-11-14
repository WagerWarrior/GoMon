/**
 * Live numbers for the engine card, all from Atlas: stage latency (timings, last 24 h, else the latest 300 rows),
 * which workers claimed utterances, failed batches, backlog, what was heard in the last 15 minutes, and the model.
 */
import { cached, db, scope } from "@/lib/db";
import type { EngineInput, StageNum } from "@/lib/engine-health";

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null);

export function engine(): Promise<EngineInput & { window: string }> {
  return cached("engine", 4000, async () => {
    const d = await db(); const { teamId } = scope(); const now = Date.now();
    const day = new Date(now - 24 * 3600_000); const hour = new Date(now - 3600_000); const q15 = new Date(now - 15 * 60_000);
    const u = d.collection("utterances");
    let rows = await d.collection("timings").find({ teamId, at: { $gte: day } }, { projection: { stage: 1, ms: 1 } }).toArray();
    let window = "last 24 h";
    if (!rows.length) { rows = await d.collection("timings").find({ teamId }, { projection: { stage: 1, ms: 1 } }).sort({ _id: -1 }).limit(300).toArray(); window = "latest runs"; }
    const by: Record<string, number[]> = {};
    for (const r of rows as any[]) (by[r.stage] ??= []).push(r.ms);
    const stages: Record<string, StageNum> = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { p50: pct(v, 0.5), p95: pct(v, 0.95), n: v.length }]));
    const [workers, failed, backlog, heard, ev] = await Promise.all([
      u.aggregate([{ $match: { teamId, claimedAt: { $gte: hour }, claimedBy: { $exists: true } } }, { $group: { _id: "$claimedBy", n: { $sum: 1 }, lastAt: { $max: "$claimedAt" } } }, { $sort: { lastAt: -1 } }]).toArray(),
      u.countDocuments({ teamId, error: { $exists: true }, receivedAt: { $gte: day } }),
      u.countDocuments({ teamId, processedAt: { $exists: false }, receivedAt: { $lt: new Date(now - 30_000), $gte: day } }),
      u.aggregate([{ $match: { teamId, receivedAt: { $gte: q15 } } }, { $group: { _id: "$source", n: { $sum: 1 } } }]).toArray(),
      d.collection("agent_events").findOne({ teamId }, { sort: { _id: -1 }, projection: { model: 1 } }),
    ]);
    return {
      window, stages, failed, backlog,
      workers: workers.map((w: any) => ({ id: String(w._id), lastAt: new Date(w.lastAt).toISOString(), n: w.n })),
      heard15: heard.reduce((a: number, h: any) => a + h.n, 0),
      sources: Object.fromEntries(heard.map((h: any) => [String(h._id ?? "unknown"), h.n])),
      model: (ev as any)?.model ?? null,
    };
  }, 30_000);
}
