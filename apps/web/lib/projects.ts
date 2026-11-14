/** Projects (`projects`): the team's working projects plus the reserved company-context project, with usage counts. */
import { cached, db, scope } from "./db";
import { COMPANY_PROJECT } from "./scope";
import type { ProjectDoc } from "./types";

export interface ProjectRow extends ProjectDoc { company: boolean; memories: number; calls: number; lastCallAt: string | null }

export function projects(): Promise<ProjectRow[]> {
  return cached("projects", 3000, async () => {
    const d = await db(); const { teamId } = scope();
    const [rows, mems, calls] = await Promise.all([
      d.collection<ProjectDoc>("projects").find({ teamId, status: "active" }).sort({ createdAt: 1 }).toArray(),
      d.collection("memories").aggregate<{ _id: string; n: number }>([{ $match: { teamId, status: "active" } }, { $group: { _id: "$projectId", n: { $sum: 1 } } }]).toArray(),
      d.collection("calls").aggregate<{ _id: string; n: number; last: Date }>([{ $match: { teamId } }, { $group: { _id: "$projectId", n: { $sum: 1 }, last: { $max: "$startedAt" } } }]).toArray(),
    ]);
    const m = new Map(mems.map((r) => [r._id, r.n])); const k = new Map(calls.map((r) => [r._id, r]));
    const out = rows.map((p) => ({
      ...p, company: p._id === COMPANY_PROJECT, memories: m.get(p._id) ?? 0, calls: k.get(p._id)?.n ?? 0,
      lastCallAt: k.get(p._id)?.last ? new Date(k.get(p._id)!.last).toISOString() : null,
    }));
    return JSON.parse(JSON.stringify(out)) as ProjectRow[];
  });
}

/** Display name per project id; ids without a projects row (legacy env PROJECT_ID) show as the id. */
export async function projectNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>([[COMPANY_PROJECT, "Company context"]]);
  for (const p of await projects()) names.set(p._id, p.name);
  return names;
}

/** Team members for the "Start as" / "Create as" pickers, leads first. The worker's policy check decides who may act. */
export function people(): Promise<string[]> {
  return cached("people", 10_000, async () => {
    const { teamId } = scope();
    const rows = await (await db()).collection("members").find({ teamId }).project<{ displayName: string; role: string }>({ displayName: 1, role: 1 }).toArray();
    return rows.sort((a, b) => Number(b.role === "lead") - Number(a.role === "lead") || a.displayName.localeCompare(b.displayName)).map((m) => m.displayName);
  });
}

export interface BotCall { id: string; title: string; projectId: string; startedAt: string | null; meetingUrl?: string }
/**
 * Meetings started from the workspace (POST /api/meetings sets botId + requestedBy) in the last 12 h and not ended yet:
 * where Gomon is, or is joining, right now. Bots sent by the CLI script also set botId, but have no requestedBy.
 */
export async function botCalls(): Promise<BotCall[]> {
  const { teamId } = scope();
  const since = new Date(Date.now() - 12 * 3600_000);
  const rows = await (await db()).collection("calls").find({ teamId, botId: { $exists: true }, requestedBy: { $exists: true }, status: { $nin: ["ended", "failed"] }, startedAt: { $gte: since } })
    .project<{ _id: string; title?: string; projectId?: string; startedAt?: Date; meetingUrl?: string }>({ title: 1, projectId: 1, startedAt: 1, meetingUrl: 1 }).sort({ startedAt: -1 }).limit(20).toArray();
  return rows.map((c) => ({ id: String(c._id), title: c.title ?? "Design call", projectId: c.projectId ?? scope().projectId, startedAt: c.startedAt ? new Date(c.startedAt).toISOString() : null, meetingUrl: c.meetingUrl }));
}
