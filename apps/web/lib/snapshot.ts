import type { Db } from "mongodb";
import { scope } from "./db";

/** Collections the workspace shows, and how each is scoped (spec: every memory read filters teamId + projectId). */
export const PANELS = ["calls", "utterances", "call_items", "memories", "conflicts", "actions", "audit_events", "timings", "members"] as const;
export type Panel = (typeof PANELS)[number];

export async function loadPanel(d: Db, panel: Panel, callId: string): Promise<unknown[]> {
  const { teamId, projectId } = scope();
  const call = { callId };
  const teamProj = { teamId, projectId };
  switch (panel) {
    case "calls": return d.collection("calls").find({ _id: callId as any }).toArray();
    case "utterances": return d.collection("utterances").find(call).sort({ seq: 1 }).limit(500).toArray();
    case "call_items": return d.collection("call_items").find(call).sort({ _id: 1 }).limit(300).toArray();
    case "memories": return d.collection("memories").find(teamProj, { projection: { embedding: 0 } }).sort({ createdAt: 1, _id: 1 }).limit(500).toArray();
    case "conflicts": return d.collection("conflicts").find(call).sort({ _id: -1 }).limit(100).toArray();
    case "actions": return d.collection("actions").find({ $or: [call, { ...teamProj, callId: { $exists: false } }] }).sort({ _id: -1 }).limit(100).toArray();
    case "audit_events": return d.collection("audit_events").find({ $or: [call, teamProj] }).sort({ at: -1 }).limit(100).toArray();
    case "timings": return d.collection("timings").find(call).sort({ _id: -1 }).limit(1000).toArray();
    case "members": return d.collection("members").find({ teamId }).sort({ displayName: 1 }).toArray();
  }
}

export async function loadAll(d: Db, callId: string): Promise<Record<Panel, unknown[]>> {
  const entries = await Promise.all(PANELS.map(async (p) => [p, await loadPanel(d, p, callId)] as const));
  return Object.fromEntries(entries) as Record<Panel, unknown[]>;
}
