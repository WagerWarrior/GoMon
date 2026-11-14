/**
 * Cut-off questions (Max, Nov 14, live): the transcriber often commits "Hey, Gomon." or "Hey, Gomon, can you like-" on its
 * own and the real question arrives as the next sentence, without the name. Gomon answered the fragment ("Go ahead, I'm
 * listening", "your question got cut off") and then ignored the question. Now a fragment is held: the next sentence from the
 * same speaker is the question. If nothing follows, the fragment is answered as before.
 */
import { parseWake } from "./wake.ts";

/** A wake line whose request is missing or cut: nothing after the name, a word cut with "-", or three words or fewer with no end mark. */
export function incompleteAsk(text: string): boolean {
  const w = parseWake(text);
  if (!w.addressed) return false;
  const t = text.trim();
  if (/-["'”’]?$/.test(t)) return true; // cut mid-word: "can you like-", "I'm just wondering w-"
  const rest = w.rest.split(/\s+/).filter((x) => x && !/^(um+|uh+|so|okay|ok|like|well)$/.test(x));
  const total = t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean).length;
  // The question can come before the name ("...link this into our chat? Hey, Gomon."): then the line is complete.
  const before = total - w.rest.split(/\s+/).filter(Boolean).length - (w.heardAs?.split(" ").length ?? 1);
  if (before >= 6) return false;
  if (rest.length === 0) return true;
  return rest.length <= 3 && !/[.?!]["'”’]?$/.test(t);
}

type Held = { at: number; speaker: string; text: string };
const held = new Map<string, Held>();
/** How long after the fragment (or the last sound from the room) the next sentence still counts as its question. */
export const CARRY_MS = 10_000;

/** The room is still talking: keeps a held fragment alive. */
export function notePartial(callId: string, now = Date.now()): void {
  const h = held.get(callId);
  if (h) h.at = now;
}

/**
 * Decide at ingest: `hold` (do not answer this line yet) or `carried` (this line continues a held fragment: the fragment's
 * text, to put in front of it).
 */
export function routeAsk(callId: string, speaker: string, text: string, now = Date.now()): { hold: boolean; carried: string | null } {
  const h = held.get(callId);
  if (parseWake(text).addressed) {
    if (incompleteAsk(text)) { held.set(callId, { at: now, speaker, text }); return { hold: true, carried: null }; }
    held.delete(callId);
    return { hold: false, carried: null };
  }
  if (!h) return { hold: false, carried: null };
  held.delete(callId);
  return now - h.at <= CARRY_MS && h.speaker === speaker ? { hold: false, carried: h.text } : { hold: false, carried: null };
}

/** Nothing followed: hand the fragment back to be answered. False if it was carried, replaced, or the room is still talking. */
export function releaseHeld(callId: string, text: string, quietMs: number, now = Date.now()): "released" | "wait" | "gone" {
  const h = held.get(callId);
  if (!h || h.text !== text) return "gone";
  if (now - h.at < quietMs) return "wait";
  held.delete(callId);
  return "released";
}
