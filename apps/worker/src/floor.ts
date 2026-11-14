/**
 * Floor rules (Max, Nov 14, from the live demo): who Gomon may answer, and when a person takes the floor back from it.
 *   1. Only a spoken wake word addresses Gomon. The analysis model may not decide on its own that a line was "for Gomon":
 *      in call-202611142054-291b it answered "How can we resolve the EU residency question?" and "What do you think we should
 *      do?" (no name said), and the 20 s follow-up window answered "Is that a larf? Yeah, it".
 *   2. Barge-in: Gomon stops talking when someone says "stop", says five words over it, or talks over it for one second.
 *      Its own voice coming back through the microphone never stops it, and neither does the end of the asker's question.
 * Pure functions, no database: tested in test/floor.test.ts.
 */
import type { Analysis } from "./llm.ts";

/** Without a wake word in the batch, nothing the model returned may be spoken or acted on as a request to Gomon. */
export function gateToWake(a: Analysis, woke: boolean): Analysis {
  if (woke) { a.addressed = true; return a; }
  a.addressed = false;
  a.reply = "";
  a.replyKind = "none";
  a.sources = [];
  a.command = { type: "none", memoryId: "", itemRef: "", newText: "", query: "" };
  a.github = { ...a.github, op: "none" };
  return a;
}

export const BARGE_WORDS = 5;
export const BARGE_MS = 1000;
/** The first moments of a clip overlap the end of what the person was already saying: not counted. */
export const BARGE_GRACE_MS = 300;
const STOP = /\b(stop|be quiet|shut up|hold on|enough)\b/i;
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

/** Share of the heard words that Gomon itself is saying right now (its voice comes back through the meeting audio). */
export function echoShare(heard: string, speaking: string): number {
  const h = words(heard);
  if (!h.length) return 1;
  const said = new Set(words(speaking));
  return h.filter((w) => said.has(w)).length / h.length;
}

export type BargeIn = "stop_word" | "talk_over" | null;

/**
 * Should Gomon stop talking? (Max, Nov 14, after the demo: "stop", five words, or one second of someone talking stops it;
 * it never stops itself.)
 *   heard          a partial or committed transcript from a person
 *   speaking       the line Gomon is saying (null when silent)
 *   ms             how long this person has been talking in this turn (0 when unknown: a committed sentence)
 *   speakingForMs  how long Gomon's clip has been playing
 * Only talk that overlaps Gomon's voice counts. Before this the whole turn counted, so the asker finishing their own question
 * cut the answer after a second, and that is why talk-over was switched off for a while.
 * Talk-over is off unless BARGE_TALK_OVER=on (Nov 14, demo call-202611142346-9d3f): every talk-over cut that day was someone
 * narrating to the room, never a real stop, and both first answers of the demo were lost. "Stop" and the name still cut it.
 */
export function bargeIn(heard: string, speaking: string | null, ms = 0, speakingForMs = Infinity, talkOver = process.env.BARGE_TALK_OVER === "on"): BargeIn {
  if (speaking === null) return null;
  const h = words(heard);
  if (!h.length) return null;
  // Gomon hearing itself (its voice comes back through the microphone) is never an interruption.
  if (echoShare(heard, speaking) >= 0.5) return null;
  if (STOP.test(heard) && !STOP.test(speaking)) return "stop_word";
  if (!talkOver) return null;
  const over = Math.max(0, speakingForMs - BARGE_GRACE_MS);
  if (ms > 0) {
    const overlap = Math.min(ms, over);
    if (overlap >= BARGE_MS && h.length >= 2) return "talk_over";
    // Words said while Gomon was talking, by share of the turn.
    return Math.floor((h.length * overlap) / ms) >= BARGE_WORDS ? "talk_over" : null;
  }
  // A committed sentence of unknown length: five words, once the clip has played long enough that they were said over it.
  return h.length >= BARGE_WORDS && over >= 1500 ? "talk_over" : null;
}

/** The Meet chat line for an answer that was cut off, so nothing Gomon found is lost (Meet's limit: 500 characters). Pure. */
export function cutNote(text: string): string {
  const head = 'Gomon was cut off. It was saying: "';
  const room = 500 - head.length - 2;
  const t = text.trim();
  return `${head}${t.length > room ? `${t.slice(0, room - 1).trimEnd()}…` : t}"`;
}
