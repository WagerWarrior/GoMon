/**
 * Gomon's camera tile in the meeting: a JPEG state card (public/cards/*.jpg) pushed through Recall's Output Video endpoint, so
 * people see what Gomon is doing (listening / thinking / speaking / locking) without any webpage or tunnel.
 */
import { readFileSync } from "node:fs";
import type { Cols } from "./db.ts";

export type CardState = "listening" | "thinking" | "speaking" | "locking";
const STATES: readonly CardState[] = ["listening", "thinking", "speaking", "locking"];

const env = {
  recallKey: () => process.env.RECALL_API_KEY ?? "",
  region: () => process.env.RECALL_REGION || "us-west-2",
};

// Object.fromEntries loses the key type; the keys are exactly STATES.
const images = Object.fromEntries(
  STATES.map((s) => [s, readFileSync(new URL(`../public/cards/${s}.jpg`, import.meta.url)).toString("base64")]),
) as Record<CardState, string>;

/** Card image for bot creation (`automatic_video_output`). */
export const cardB64 = (s: CardState): string => images[s];

const shown = new Map<string, CardState>();
/** While audio plays, only "locking" or the end of speech (force) may replace the Speaking card. */
const speakingUntil = new Map<string, number>();

export async function showCard(c: Cols, callId: string, state: CardState, opts: { forMs?: number; force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (state === "speaking") speakingUntil.set(callId, now + (opts.forMs ?? 3000));
  else if (opts.force) speakingUntil.delete(callId);
  else if (state !== "locking" && (speakingUntil.get(callId) ?? 0) > now) return;
  if (shown.get(callId) === state) return;
  const call = await c.calls.findOne({ _id: callId as never }, { projection: { botId: 1 } });
  const botId = typeof call?.botId === "string" ? call.botId : "";
  if (!botId || !env.recallKey()) return;
  shown.set(callId, state);
  const res = await fetch(`https://${env.region()}.recall.ai/api/v1/bot/${botId}/output_video/`, {
    method: "POST",
    headers: { authorization: `Token ${env.recallKey()}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ kind: "jpeg", b64_data: images[state] }),
  }).catch(() => null);
  if (!res?.ok) shown.delete(callId); // retry on the next change
}
