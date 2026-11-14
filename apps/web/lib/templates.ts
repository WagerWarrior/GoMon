/** Agent templates (Rob's `agent_templates`) and which calls use each one. Read-only here; writes go through the worker. */
import { cached, db, scope } from "./db";

export function templates() {
  return cached("templates", 2000, async () => {
    const d = await db(); const { teamId, projectId } = scope();
    const [rows, use, leads] = await Promise.all([
      d.collection("agent_templates").find({ teamId }).sort({ createdAt: 1 }).toArray(),
      d.collection("calls").aggregate([{ $match: { teamId, projectId } }, { $group: { _id: { $ifNull: ["$templateId", "design-review"] }, n: { $sum: 1 } } }]).toArray(),
      d.collection("members").find({ teamId, role: "lead" }).project({ displayName: 1 }).toArray(),
    ]);
    const n = new Map(use.map((u) => [String(u._id), u.n as number]));
    return JSON.parse(JSON.stringify({ rows: rows.map((t) => ({ ...t, sessions: n.get(String(t._id)) ?? 0 })), leads: leads.map((l) => l.displayName) }));
  });
}
