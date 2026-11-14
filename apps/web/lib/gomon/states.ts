/**
 * Gomon's face (design: design/gomon). One place for the avatar's states, look and theme,
 * plus deriveGomonState, which picks the face from live call data so the avatar reacts to what Atlas says.
 */
import definition from "./definition.json";

export const GOMON_DEFINITION = definition;
export const GOMON_THEME = { leaf: "#1f9d55", eye: "#0b2418", rest: "#a9b8af", depth: 11 } as const;

export type GomonMood = "idle" | "thinking" | "happy";
export type GomonStateKey = "listening" | "recalling" | "speaking" | "locking" | "locked" | "vetoed" | "acting";
export interface GomonState { label: string; mood: GomonMood; look?: { x: number; y: number }; follow?: boolean; muted?: boolean; line: string }

export const GOMON_STATES: Record<GomonStateKey, GomonState> = {
  listening: { label: "Listening", mood: "idle", follow: true, line: "Follows whoever is talking." },
  recalling: { label: "Recalling", mood: "thinking", look: { x: 0.55, y: -0.35 }, line: "Looks up and away while it searches memory." },
  speaking: { label: "Speaking", mood: "idle", look: { x: 0, y: 0 }, line: "Looks at the room, with voice bars." },
  locking: { label: "Locking", mood: "thinking", look: { x: 0, y: 0.15 }, line: "A 10 s ring. Anyone can veto." },
  locked: { label: "Locked", mood: "happy", look: { x: 0, y: -0.2 }, line: "Smiles once the decision is memory." },
  vetoed: { label: "Vetoed", mood: "idle", look: { x: -0.1, y: 0.75 }, muted: true, line: "Fades and looks down. Nothing written." },
  acting: { label: "Acting", mood: "happy", look: { x: 0.6, y: 0.1 }, line: "Glances at the outbox as tickets go out." },
};

/** How long an event keeps its face before Gomon goes back to listening. */
export const FRESH_MS = 6000;

const EVENT_FACE: Record<string, GomonStateKey> = {
  memory_promoted: "locked", memory_locked: "locked", item_rejected: "vetoed", action_sent: "acting", action_requested: "acting",
  memory_corrected: "recalling", memory_forgotten: "vetoed",
};

type Live = {
  call_items: { status: string; lockAnnouncedAt?: Date | string | null; vetoMs?: number }[];
  audit_events: { type: string; at: Date | string }[];
  utterances: { speaker: { displayName: string }; startedAt?: Date | string; endedAt?: Date | string }[];
};

export function deriveGomonState(d: Live, now: number, ui: { asking?: boolean } = {}): { key: GomonStateKey; secondsLeft?: number } {
  const locking = d.call_items.find((i) => i.status === "locking" && i.lockAnnouncedAt);
  if (locking) {
    const end = new Date(locking.lockAnnouncedAt!).getTime() + (locking.vetoMs ?? 10000);
    if (end > now) return { key: "locking", secondsLeft: Math.ceil((end - now) / 1000) };
  }
  if (ui.asking) return { key: "recalling" };
  const fresh = (t?: Date | string) => !!t && now - new Date(t).getTime() < FRESH_MS;
  const last = d.utterances[d.utterances.length - 1];
  if (last?.speaker.displayName === "Gomon" && fresh(last.endedAt ?? last.startedAt)) return { key: "speaking" };
  const ev = [...d.audit_events].filter((e) => EVENT_FACE[e.type] && fresh(e.at)).sort((a, b) => +new Date(b.at) - +new Date(a.at))[0];
  return { key: ev ? EVENT_FACE[ev.type] : "listening" };
}
