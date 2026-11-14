/** Grouping helpers that turn per-second event streams into a few readable bundles. Pure; tested in test/group.test.ts. */

/** Split time-ordered items into bursts: a new burst starts when the gap to the previous item exceeds gapMs. */
export function bursts<T>(items: T[], at: (x: T) => string | Date, gapMs = 60_000): T[][] {
  const sorted = [...items].sort((a, b) => +new Date(at(a)) - +new Date(at(b)));
  const out: T[][] = [];
  for (const x of sorted) {
    const cur = out[out.length - 1];
    if (cur && +new Date(at(x)) - +new Date(at(cur[cur.length - 1])) <= gapMs) cur.push(x); else out.push([x]);
  }
  return out;
}

/** Collapse runs of neighbours that share a key into one entry with a count, keeping the order. */
export function collapse<T>(items: T[], key: (x: T) => string): { item: T; n: number; last: T }[] {
  const out: { item: T; n: number; last: T }[] = [];
  for (const x of items) {
    const cur = out[out.length - 1];
    if (cur && key(cur.item) === key(x)) { cur.n++; cur.last = x; } else out.push({ item: x, n: 1, last: x });
  }
  return out;
}

/** Group items by a key, keeping first-seen order of the groups. */
export function groupBy<T>(items: T[], key: (x: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of items) { const k = key(x); (m.get(k) ?? m.set(k, []).get(k)!).push(x); }
  return [...m.entries()];
}
