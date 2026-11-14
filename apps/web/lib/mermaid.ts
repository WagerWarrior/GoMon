import type { Memory } from "./types";

/**
 * Architecture/decision diagram generated ONLY from active memories (no model, no invention).
 * Nodes: requirements/constraints/decisions. Edge A --> B when B's text or key cites A's key (e.g. "R-12", "D-09").
 * Memories without any link attach to the project node so nothing active is silently omitted.
 */
const shape = (k: string, id: string, label: string) =>
  k === "requirement" ? `${id}[["${label}"]]` : k === "constraint" ? `${id}{{"${label}"}}` : k === "risk" ? `${id}>"${label}"]` : `${id}("${label}")`;
const clean = (s: string, n = 54) => (s.length > n ? s.slice(0, n - 1) + "…" : s).replace(/["\n\r]/g, " ");

export function buildDiagram(memories: Memory[], projectLabel: string): string {
  const active = memories.filter((m) => m.status === "active");
  const idOf = (m: Memory, i: number) => "n" + (m.key ? m.key.replace(/[^A-Za-z0-9]/g, "_") : String(i));
  const ids = new Map(active.map((m, i) => [m, idOf(m, i)] as const));
  const lines = ["flowchart LR", `  P(["${clean(projectLabel, 40)}"])`];
  for (const m of active) lines.push("  " + shape(m.kind, ids.get(m)!, `${m.key ? m.key + " " : ""}${clean(m.text)}${m.version > 1 ? " (v" + m.version + ")" : ""}`));
  const linked = new Set<Memory>();
  for (const a of active) {
    if (!a.key) continue;
    const re = new RegExp(`\\b${a.key.replace(/[-]/g, "\\-")}\\b`);
    for (const b of active) if (b !== a && re.test(b.text)) { lines.push(`  ${ids.get(a)} --> ${ids.get(b)}`); linked.add(a); linked.add(b); }
  }
  for (const m of active) if (!linked.has(m)) lines.push(`  P --> ${ids.get(m)}`);
  lines.push("  classDef req fill:#e8f0fe,stroke:#4c8bf5;", "  classDef con fill:#fff4e5,stroke:#f5a04c;");
  for (const m of active) if (m.kind === "requirement") lines.push(`  class ${ids.get(m)} req;`); else if (m.kind === "constraint") lines.push(`  class ${ids.get(m)} con;`);
  return lines.join("\n");
}
