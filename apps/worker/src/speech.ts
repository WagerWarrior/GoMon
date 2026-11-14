/**
 * What Gomon says out loud, made safe for a voice (Max, Nov 14): no links read aloud (they go to the Meet chat), no sentence
 * cut in the middle. Live it said "https://github. com/WagerWarrior..." and "…adds about 0." because sentences were split on
 * every period, including the ones inside "github.com" and "0.2 ms". Pure, tested in test/speech.test.ts.
 */
const count = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** At most two whole sentences and about 42 words; URLs removed. `cut`: the model ran out of tokens mid-sentence. */
export function spokenLine(text: string, cut = false): string {
  const t = text.replace(/\(?https?:\/\/\S+\)?/g, "").replace(/#(?=\d)/g, "").replace(/\s+([.,!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  // A sentence ends at . ! ? followed by a space and a capital (not inside "github.com", "0.2", "v1.4").
  let sentences = t.split(/(?<=[.!?]["”’]?)\s+(?=["“(]?[A-Z])/).filter(Boolean);
  if (cut && sentences.length > 1 && !/[.!?]["”’]?$/.test(sentences[sentences.length - 1])) sentences = sentences.slice(0, -1);
  let out = sentences.slice(0, 2).join(" ");
  if (count(out) > 42) out = sentences[0] ?? "";
  if (count(out) > 48) {
    const words = out.split(/\s+/).slice(0, 42).join(" ");
    const at = Math.max(words.lastIndexOf(","), words.lastIndexOf(";"), words.lastIndexOf(":"));
    out = `${(at > words.length / 2 ? words.slice(0, at) : words).replace(/[,;:]$/, "")}.`;
  }
  return out.trim();
}

/** GitHub issues the line names ("issue 25", "#25", "ticket number 25"), as links for the Meet chat. */
export function issueLinks(text: string, repo: string): { number: number; url: string }[] {
  const nums = new Set<number>();
  for (const m of text.matchAll(/(?:\b(?:issue|ticket|pr|pull request)s?\s+(?:number\s+)?#?|#)(\d{1,5})\b/gi)) nums.add(Number(m[1]));
  return [...nums].map((n) => ({ number: n, url: `https://github.com/${repo}/issues/${n}` }));
}
