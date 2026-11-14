export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
export function stageStats(rows: { stage: string; ms: number }[]) {
  const by = new Map<string, number[]>();
  for (const r of rows) (by.get(r.stage) ?? by.set(r.stage, []).get(r.stage)!).push(r.ms);
  return [...by.entries()].map(([stage, v]) => ({ stage, n: v.length, p50: percentile(v, 50), p95: percentile(v, 95) }));
}
