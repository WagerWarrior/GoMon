/**
 * Quotable context from Atlas for the composer's database picker: memory (facts from docs, decisions from meetings),
 * this call's items, transcript quotes, and past meeting summaries. Pure helpers; the route does the reads.
 */
export type Source = "memory" | "items" | "quotes" | "meetings";
export const SOURCES: { key: Source; label: string; hint: string }[] = [
  { key: "memory", label: "Memory", hint: "Search by meaning or key: D-13, rate limits…" },
  { key: "items", label: "This call", hint: "Decisions, actions and questions captured in this call" },
  { key: "quotes", label: "Transcript", hint: "Quote what someone said in this call" },
  { key: "meetings", label: "Past meetings", hint: "Summaries of earlier meetings in this project" },
];

export type Hit = { src: Source; id: string; title: string; text: string; tag?: string; meta?: string; score?: number };

/** A key like "D-13", "r-", "K" searches by key prefix; anything else searches by meaning. */
export const isKeyQuery = (q: string) => /^[a-z]{1,2}(-\d{0,3})?$/i.test(q.trim());

/** What Gomon receives when the item is attached: one line that says where it came from, then the text. */
export function quote(h: Hit): string {
  const text = h.text.replace(/\s+/g, " ").trim();
  switch (h.src) {
    case "memory": return `[${h.title}${h.tag ? ` · ${h.tag}` : ""}${h.meta ? ` · ${h.meta}` : ""}] ${text}`;
    case "items": return `[This call · ${h.title}${h.tag ? ` · ${h.tag}` : ""}] ${text}`;
    case "quotes": return `"${text}" (${h.title}${h.meta ? `, ${h.meta}` : ""})`;
    case "meetings": return `[Meeting: ${h.title}${h.meta ? `, ${h.meta}` : ""}] ${text}`;
  }
}

/** Chip label for an attached item. */
export const chipLabel = (h: Hit) => (h.src === "quotes" ? `${h.title}: ${h.text.slice(0, 28)}${h.text.length > 28 ? "…" : ""}` : h.title);

/** Memory origin in plain words: ingested docs are facts, call-origin memory was decided in a meeting. */
export const originLabel = (origin?: string) => (origin === "doc" ? "fact" : origin === "call" ? "from a meeting" : origin ?? "");
