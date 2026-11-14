// Recall.ai real-time transcript event -> Gomon utterance contract (spec §9).
// Only finalized segments (`transcript.data`) become utterances; partials are dropped.
//
// Verified against docs.recall.ai (2026-11-14):
//   body = { event, data: { data: { words: [{ text, start_timestamp: { relative }, end_timestamp: { relative } | null }],
//            language_code, participant: { id, name, is_host, platform, extra_data, email } },
//            transcript: { id, metadata }, recording: { id, metadata }, realtime_endpoint: { id, metadata },
//            bot: { id, metadata } } }
//   - word timestamps carry only `relative` (seconds since recording start); there is no `absolute`.
//   - Recall has no per-segment id, so sourceKey = bot + participant + first-word relative start.
import { createHmac, timingSafeEqual } from "node:crypto";

export const FINAL_EVENT = "transcript.data";
export const PARTIAL_EVENT = "transcript.partial_data";
// Barge-in signal: Recall fires this when a participant starts talking (docs.recall.ai real-time webhook endpoints).
// It carries no text, so it can never become an utterance or trigger an action; it only stops Gomon's audio.
export const SPEECH_ON_EVENT = "participant_events.speech_on";

/** Participant who started speaking, or null when the payload is not a speech_on event. */
export function speechOnParticipant(body) {
  if (!body || body.event !== SPEECH_ON_EVENT) return null;
  const p = body.data?.data?.participant ?? {};
  return { id: p.id ?? null, name: typeof p.name === "string" ? p.name : "" };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Relative (seconds) bounds of a segment, or null when the payload has no usable timestamps. */
export function segmentBounds(body) {
  const words = body?.data?.data?.words;
  if (!Array.isArray(words) || !words.length) return null;
  const start = num(words[0]?.start_timestamp?.relative);
  let end = null;
  for (let i = words.length - 1; i >= 0 && end == null; i--) {
    end = num(words[i]?.end_timestamp?.relative) ?? num(words[i]?.start_timestamp?.relative);
  }
  return start == null ? null : { start, end: end ?? start };
}

/**
 * @param {any} body Recall real-time webhook body
 * @param {string} callId our call id
 * @param {{ anchorMs?: number|null }} [opts] wall-clock ms of the bot's recording t=0 (estimated by the server),
 *   used to turn Recall's relative seconds into ISO timestamps. Without it startedAt/endedAt are null.
 */
export function toUtterance(body, callId, { anchorMs = null } = {}) {
  if (!body || body.event !== FINAL_EVENT) return null;
  const seg = body.data?.data;
  const words = Array.isArray(seg?.words) ? seg.words : [];
  const text = words.map((w) => (typeof w?.text === "string" ? w.text : "")).join(" ")
    .replace(/\s+/g, " ").replace(/\s+([,.?!;:])/g, "$1").trim();
  if (!text) return null;

  const participant = seg.participant ?? {};
  const botId = body.data?.bot?.id ?? "nobot";
  const b = segmentBounds(body);
  const iso = (sec) => (anchorMs != null && sec != null ? new Date(anchorMs + sec * 1000).toISOString() : null);

  return {
    callId,
    sourceKey: `recall:${botId}:${participant.id ?? "unknown"}:${b ? b.start.toFixed(3) : text}`,
    speaker: { displayName: participant.name || "Unknown speaker" },
    text,
    startedAt: iso(b?.start),
    endedAt: iso(b?.end),
    source: "recall",
  };
}

/**
 * Verify a Recall-signed request (workspace verification secret, docs: "Authenticating requests from Recall.ai").
 * HMAC-SHA256(base64decode(secret without "whsec_"), `${id}.${timestamp}.${rawBody}`), base64; header holds
 * space-separated "v1,<sig>" entries (several during secret rotation).
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyRecallSignature({ secret, headers, rawBody, nowMs = Date.now(), toleranceSec = 300 }) {
  if (!secret?.startsWith("whsec_")) return { ok: false, reason: "secret must start with whsec_" };
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sig = headers["webhook-signature"];
  if (!id || !ts || !sig) return { ok: false, reason: "missing webhook-* headers (is the workspace secret created?)" };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(nowMs / 1000 - tsNum) > toleranceSec) return { ok: false, reason: "stale timestamp" };
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  for (const entry of String(sig).split(" ")) {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) continue;
    const got = Buffer.from(value, "base64");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}
