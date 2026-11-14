/**
 * One context window for a model call, built the same way every time (Max, Nov 14): named sections in a fixed order, each
 * with its own token budget, and an account of what went in and what was cut. Before this each lane glued strings together
 * with no size limit and no record, so nobody could say what Gomon had in front of it when it answered.
 * The design follows what coding harnesses do (T3 Code tracks token use per turn and compacts on a threshold): the rolling
 * call summary (summary.ts) is the compaction, this is the budget and the meter. Pure, tested in test/window.test.ts.
 */
export type Section = {
  /** Heading the prompt refers to ("TEAM MEMORY"); "" for a bare line such as the call header. */
  title: string;
  lines: string[];
  /** Token budget for this section's lines. */
  budget: number;
  /** What to keep when over budget: "head" for ranked results (best first), "tail" for a transcript (newest last). */
  keep: "head" | "tail";
  /** Shown under the title when there are no lines; a section with neither is left out. */
  empty?: string;
};
export type SectionUse = { title: string; tokens: number; lines: number; dropped: number };
export type Window = { text: string; use: SectionUse[]; tokens: number; dropped: number };

/** Rough token count (about 4 characters a token); the API's own `usage` is recorded next to it as the real number. */
export const tokensOf = (s: string): number => Math.ceil(s.length / 4);

export function buildWindow(sections: Section[]): Window {
  const parts: string[] = [];
  const use: SectionUse[] = [];
  for (const s of sections) {
    // One over-long line may not eat the section: cap it at half the budget.
    const cap = Math.max(40, s.budget * 2);
    const lines = s.lines.filter((l) => l.trim()).map((l) => (l.length > cap ? `${l.slice(0, cap - 1)}…` : l));
    const ordered = s.keep === "tail" ? [...lines].reverse() : lines;
    const kept: string[] = [];
    let spent = 0;
    for (const l of ordered) {
      const t = tokensOf(l);
      if (spent + t > s.budget) break;
      kept.push(l);
      spent += t;
    }
    if (s.keep === "tail") kept.reverse();
    const body = kept.length ? kept : s.empty ? [s.empty] : [];
    if (body.length) parts.push(...(s.title ? [`${s.title}:`] : []), ...body);
    use.push({ title: s.title || "header", tokens: spent, lines: kept.length, dropped: lines.length - kept.length });
  }
  return { text: parts.join("\n"), use, tokens: use.reduce((n, u) => n + u.tokens, 0), dropped: use.reduce((n, u) => n + u.dropped, 0) };
}
