import type { Cols } from "./db.ts";
import { ITEM_KINDS, type AgentTemplate, type ItemKind } from "./shapes.ts";

export const DEFAULT_TEMPLATE_ID = "design-review";

type Builtin = Omit<AgentTemplate, "teamId" | "version" | "createdAt" | "updatedAt" | "updatedBy">;

/** Seeded templates (synthetic). Teams create more through POST /api/templates or the workspace. */
export const BUILTIN_TEMPLATES: Builtin[] = [
  {
    _id: "design-review", name: "Design review", description: "Default: flags conflicts with team memory, locks decisions by consensus.",
    persona: "Be a concise senior engineer. Prefer pointing at the exact memory that matters over general advice.",
    proactivity: "balanced", consensus: "announce_veto", vetoMs: 10_000, captureKinds: [...ITEM_KINDS],
  },
  {
    _id: "silent-scribe", name: "Silent scribe", description: "Never interrupts. Captures decisions, requirements, risks and actions; answers only when asked.",
    persona: "Stay out of the conversation. Capture only what the team clearly states.",
    proactivity: "quiet", consensus: "explicit_only", vetoMs: 10_000, captureKinds: ["decision", "requirement", "risk", "action", "open_question"],
  },
  {
    _id: "architecture-challenger", name: "Architecture challenger", description: "Pushes back: surfaces conflicts and proposes alternatives more often.",
    persona: "Act as a skeptical staff engineer. Name tradeoffs and failure modes, and propose a concrete alternative when the memories support one.",
    proactivity: "active", consensus: "announce_veto", vetoMs: 15_000, captureKinds: [...ITEM_KINDS],
  },
];

const FALLBACK: AgentTemplate = {
  ...BUILTIN_TEMPLATES[0], teamId: "", version: 1, createdAt: new Date(0), updatedAt: new Date(0), updatedBy: "system",
};

/** Per-proactivity speaking rules, read by the agent loop. Unprompted speech is limited to high-severity conflicts; spoken
 *  suggestions exist only in the challenger template. */
export const SPEAKING: Record<AgentTemplate["proactivity"], { conflictsPerBatch: number; suggestionWindowMs: number | null }> = {
  quiet: { conflictsPerBatch: 0, suggestionWindowMs: null },
  balanced: { conflictsPerBatch: 1, suggestionWindowMs: null },
  active: { conflictsPerBatch: 2, suggestionWindowMs: 2 * 60_000 },
};

const cache = new Map<string, { at: number; t: AgentTemplate }>();
const CACHE_MS = 5_000;

/** Template for a call (calls.templateId, else the default). Cached briefly so edits apply within seconds mid-call. */
export async function templateFor(c: Cols, teamId: string, templateId: unknown): Promise<AgentTemplate> {
  const id = typeof templateId === "string" && templateId ? templateId : DEFAULT_TEMPLATE_ID;
  const key = `${teamId}/${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.t;
  const t = (await c.agentTemplates.findOne({ _id: id, teamId })) ?? (await c.agentTemplates.findOne({ _id: DEFAULT_TEMPLATE_ID, teamId })) ?? FALLBACK;
  cache.set(key, { at: Date.now(), t });
  return t;
}

export type TemplateInput = Pick<AgentTemplate, "name" | "description" | "persona" | "proactivity" | "consensus" | "vetoMs" | "captureKinds" | "voiceId">;

/** Validates untrusted JSON for create/update. Returns the clean input or a list of problems. */
export function parseTemplateInput(b: Record<string, unknown>): { ok: true; value: TemplateInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const s = (k: string, max: number, required = true) => {
    const v = b[k];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || !v.trim() || v.length > max) { errors.push(`${k}: string 1-${max} chars`); return ""; }
    return v.trim();
  };
  const name = s("name", 60) ?? "";
  const description = s("description", 200) ?? "";
  const persona = s("persona", 600) ?? "";
  const voiceId = s("voiceId", 64, false);
  const proactivity = (["quiet", "balanced", "active"] as const).find((p) => p === b.proactivity);
  if (!proactivity) errors.push("proactivity: quiet | balanced | active");
  const consensus = (["announce_veto", "explicit_only"] as const).find((p) => p === b.consensus);
  if (!consensus) errors.push("consensus: announce_veto | explicit_only");
  const vetoMs = typeof b.vetoMs === "number" && b.vetoMs >= 3000 && b.vetoMs <= 60_000 ? Math.round(b.vetoMs) : NaN;
  if (Number.isNaN(vetoMs)) errors.push("vetoMs: number 3000-60000");
  const kinds = Array.isArray(b.captureKinds) ? b.captureKinds.filter((k): k is ItemKind => (ITEM_KINDS as readonly unknown[]).includes(k)) : [];
  if (!kinds.length || (Array.isArray(b.captureKinds) && kinds.length !== b.captureKinds.length)) errors.push(`captureKinds: non-empty subset of ${ITEM_KINDS.join(", ")}`);
  if (errors.length || !proactivity || !consensus) return { ok: false, errors };
  return { ok: true, value: { name, description, persona, proactivity, consensus, vetoMs, captureKinds: [...new Set(kinds)], ...(voiceId ? { voiceId } : {}) } };
}
