/**
 * Read the after-call recap (Slack mrkdwn built by apps/connectors/src/recap.ts) into parts the page can lay out:
 * a title line, prose lead, "*Section*" blocks of "• " bullets, and trailing lines. Inline: memory keys, links, *bold*.
 */
export type Section = { title: string; items: string[] };
export type Parsed = { title: string; sub: string; lead: string[]; sections: Section[]; tail: string[] };
export type Seg = { t: "text" | "b" | "key"; v: string } | { t: "url"; v: string; label: string };

export function parseRecap(text: string): Parsed {
  const lines = text.split("\n");
  const head = lines.shift() ?? "";
  const m = head.match(/^\*(.+?)\*\s*(?:·\s*(.*))?$/);
  const out: Parsed = { title: m ? m[1] : head, sub: m?.[2] ?? "", lead: [], sections: [], tail: [] };
  let cur: Section | null = null;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { if (cur) cur = null; continue; }
    const h = l.match(/^\*([^*]+)\*$/);
    if (h) { cur = { title: h[1], items: [] }; out.sections.push(cur); continue; }
    if (cur && l.startsWith("•")) { cur.items.push(l.replace(/^•\s*/, "")); continue; }
    (out.sections.length ? out.tail : out.lead).push(l);
  }
  return out;
}

const RX = /<(https?:\/\/[^|>]+)\|([^>]+)>|(https?:\/\/[^\s<>]+[^\s<>.,;:)])|\*([^*\n]+)\*|\b([A-Z]{1,2}-\d{1,3})\b/g;
export function inline(s: string): Seg[] {
  const out: Seg[] = []; let last = 0;
  for (const m of s.matchAll(RX)) {
    if (m.index! > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1]) out.push({ t: "url", v: m[1], label: m[2] });
    else if (m[3]) out.push({ t: "url", v: m[3], label: m[3].replace(/^https?:\/\/(www\.)?/, "") });
    else if (m[4]) out.push({ t: "b", v: m[4] });
    else out.push({ t: "key", v: m[5] });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}
