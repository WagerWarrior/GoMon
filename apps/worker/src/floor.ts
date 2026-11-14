/**
 * Floor rules (Max, Nov 14, from the live demo): who Gomon may answer, and when a person takes the floor back from it.
 *   1. Only a spoken wake word addresses Gomon. The analysis model may not decide on its own that a line was "for Gomon":
 *      in call-202611142054-291b it answered "How can we resolve the EU residency question?" and "What do you think we should
 *      do?" (no name said), and the 20 s follow-up window answered "Is that a larf? Yeah, it".
 *   2. Barge-in: Gomon stops talking when someone says "stop". Talking over it (5+ words or 1.2 s) also stops it only with
 *      BARGE_TALK_OVER=on: live (call-202611142139-869a) the asker finishing their own question cut the answer after 1 s.
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
export const BARGE_MS = 1200;
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
 * Should Gomon stop talking? `heard` is a partial or committed transcript from a person, `speaking` the line Gomon is saying
 * (null when silent), `ms` how long this person has been talking in this turn (0 when unknown). `talkOver` enables the
 * talk-over rule (off by default: an explicit stop word is the only interruption).
 */
export function bargeIn(heard: string, speaking: string | null, ms = 0, talkOver = process.env.BARGE_TALK_OVER === "on"): BargeIn {
  if (speaking === null) return null;
  const h = words(heard);
  if (!h.length) return null;
  // Gomon hearing itself is not an interruption.
  if (echoShare(heard, speaking) >= 0.5) return null;
  if (STOP.test(heard) && !STOP.test(speaking)) return "stop_word";
  if (!talkOver) return null;
  if (h.length >= BARGE_WORDS) return "talk_over";
  if (ms >= BARGE_MS && h.length >= 2) return "talk_over";
  return null;
}
