/**
 * Wake-word detection on ASR text. Ported from apps/bot-page/src/wake.js (Tamir), which documents the live-Meet evidence:
 * Recall's low-latency transcription never spells "Gomon" ("goman", "gourmand", "so man", "go on", "no man"), so the first
 * one or two words are matched by sound. A greeting ("hey/hi/yo") enables looser matches; "go on" alone is ordinary speech.
 */
const WAKE = "gomon";
const WAKE_SKELETON = "gmn";
const GREETINGS: Record<string, true> = { hey: true, hi: true, yo: true };
const ALIASES: Record<string, true> = { mongo: true, gomongo: true };
const ORDINARY: Record<string, true> = { goon: true };

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** Consonant skeleton: "gomon" -> "gmn", "gourmand" -> "gmn", "so man" -> "smn". */
function skeleton(s: string): string {
  return s.replace(/[aeiouyhwr']/g, "").replace(/(.)\1+/g, "$1").replace(/[dt]$/, "");
}

function soundsLikeWake(c: string, greeted: boolean): boolean {
  const strong = /^g[ou]/.test(c) && skeleton(c) === WAKE_SKELETON;
  if (strong || (distance(c, WAKE) <= 1 && !ORDINARY[c])) return true;
  if (!greeted) return false;
  if (ALIASES[c] || distance(c, WAKE) <= 2) return true;
  return /^[gsnck]/.test(c) && c.length <= 9 && distance(skeleton(c), WAKE_SKELETON) <= 1;
}

export type Wake = { addressed: boolean; rest: string; heardAs: string | null };

/**
 * Scribe and Recall commit whole sentences ("Chill for a sec. Hey, hey, Gomon. Can you…"), so the wake word is looked for
 * at the start of the segment, at every sentence start, and right after any greeting, not only in the first two words.
 * The request is everything after the wake word, across sentences.
 */
export function parseWake(text: string): Wake {
  const words: string[] = []; const starts = new Set<number>([0]);
  for (const sentence of text.toLowerCase().split(/[.!?]+/)) {
    const ws = sentence.replace(/[^a-z0-9' ]+/g, " ").trim().split(/\s+/).filter(Boolean);
    if (ws.length) { starts.add(words.length); words.push(...ws); }
  }
  for (let i = 0; i < words.length; i++) {
    const afterGreeting = i > 0 && GREETINGS[words[i - 1]] === true;
    if (!starts.has(i) && !afterGreeting) continue;
    let from = i; while (GREETINGS[words[from] ?? ""]) from++; // "hey, hey, Gomon"
    const greeted = afterGreeting || from > i;
    for (const n of [1, 2]) {
      const heard = words.slice(from, from + n);
      if (heard.length === n && soundsLikeWake(heard.join(""), greeted)) {
        return { addressed: true, rest: words.slice(from + n).join(" "), heardAs: heard.join(" ") };
      }
    }
  }
  return { addressed: false, rest: text, heardAs: null };
}
