// Wake-word detection on ASR text.
// Recall's low-latency transcription never spells "Gomon" and that mode has no custom vocabulary.
// Heard in a live Meet on 2026-11-14:
//   "Gomon, create the tickets" -> "so man create the tickets", "go on create the tickets", "no man create the tickets"
//   "Hey Gomon"                 -> "hey gourmand"
// So the first one or two words are matched by sound, not by exact text:
//   - always:           starts with "go"/"gu" and has the consonants g-m-n ("go mon", "goman", "gourmand"),
//                       or is one edit from "gomon" (but not the ordinary phrase "go on")
//   - after "hey/hi/yo": also looser sound-alikes ("so man", "no man", "go on") and the aliases below.
// The greeting is what keeps ordinary sentences from triggering, so the team should say "Hey Gomon".
const WAKE = "gomon";
const WAKE_SKELETON = "gmn";
const GREETINGS = new Set(["hey", "hi", "yo"]);
const ALIASES = new Set(["mongo", "gomongo"]); // "Hey Mongo": a spoken fallback ASR spells reliably
const ORDINARY = new Set(["goon"]);            // "go on ..." without a greeting is normal speech

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

// Consonant skeleton: "gomon" -> "gmn", "gourmand" -> "gmn", "so man" -> "smn", "go on" -> "gn".
const skeleton = (s) => s.replace(/[aeiouyhwr']/g, "").replace(/(.)\1+/g, "$1").replace(/[dt]$/, "");

function soundsLikeWake(c, greeted) {
  const strong = /^g[ou]/.test(c) && skeleton(c) === WAKE_SKELETON;
  if (strong || (distance(c, WAKE) <= 1 && !ORDINARY.has(c))) return true;
  if (!greeted) return false;
  if (ALIASES.has(c) || distance(c, WAKE) <= 2) return true;
  return /^[gsnck]/.test(c) && c.length <= 9 && distance(skeleton(c), WAKE_SKELETON) <= 1;
}

/**
 * @param {string} text utterance text
 * @returns {{ addressed: boolean, rest: string, heardAs: string|null }} `rest` is the text after the wake word
 */
export function parseWake(text) {
  const words = String(text ?? "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const greeted = GREETINGS.has(words[0]);
  const from = greeted ? 1 : 0;
  for (const n of [1, 2]) {
    const heard = words.slice(from, from + n);
    if (heard.length === n && soundsLikeWake(heard.join(""), greeted)) {
      return { addressed: true, rest: words.slice(from + n).join(" "), heardAs: heard.join(" ") };
    }
  }
  return { addressed: false, rest: String(text ?? ""), heardAs: null };
}
