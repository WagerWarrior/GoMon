/**
 * Gomon's camera tile in the meeting, pushed through Recall's Output Video endpoint (no webpage or tunnel needed).
 *
 * Each state has its own face and icon, drawn as SVG and encoded to JPEG with sharp:
 *  - listening: the leaf at rest, "Say Hey Gomon"
 *  - thinking:  eyes up and to the side, three animated dots, a live timer and what it is doing
 *               (the `calls.agentState.detail` line: "checking team memory", "writing the answer", ...)
 *  - speaking:  moving voice bars
 *  - locking:   a 10 s countdown ring with the seconds left and "say wait to stop it"
 * Animated states push a new frame every FRAME_MS while they last (a few seconds per answer), capped at MAX_ANIMATE_MS.
 * Without sharp (worker not reinstalled) it falls back to the four static JPEGs in public/cards.
 */
import { readFileSync } from "node:fs";
import type { Cols } from "./db.ts";

export type CardState = "listening" | "thinking" | "speaking" | "locking";
const STATES: readonly CardState[] = ["listening", "thinking", "speaking", "locking"];

const env = {
  recallKey: () => process.env.RECALL_API_KEY ?? "",
  region: () => process.env.RECALL_REGION || "us-west-2",
};

/** Frame period per animated state (ms). Listening is one still frame. */
export const FRAME_MS: Record<CardState, number> = { listening: 0, thinking: 600, speaking: 700, locking: 1000 };
const MAX_ANIMATE_MS = 45_000;
/** Longest the tile shows thinking without an answer starting. The slowest answers measured are under 5 s. */
export const THINKING_MAX_MS = 12_000;
const LOCK_MS = 10_000;

// Static fallback cards. Object.fromEntries loses the key type; the keys are exactly STATES.
const images = Object.fromEntries(
  STATES.map((s) => [s, readFileSync(new URL(`../public/cards/${s}.jpg`, import.meta.url)).toString("base64")]),
) as Record<CardState, string>;

/** Card image for bot creation (`automatic_video_output`). */
export const cardB64 = (s: CardState): string => images[s];

// ---------- drawing ----------

// Theme: design/gomon and the dashboard (apps/web globals.css): light page, hairlines, the leaf is the only color.
// Same layout as apps/bot-page: face left, words right, all inside the middle 70% (Meet crops a tile's sides).
const W = 1280;
const H = 720;
const INK = "#0b1510";
const MUTED = "#64706a";
const FAINT = "#9aa59f";
const LINE = "#e3e8e5";
const GREEN = "#1f9d55";
const LABEL: Record<CardState, string> = { listening: "Listening", thinking: "Thinking", speaking: "Speaking", locking: "Locking in" };
const LEAF = "M50 9 C54 9 81 34 81 59 C81 75 68 87 50 87 C32 87 19 75 19 59 C19 34 46 9 50 9 Z M47 85 L53 85 L52.4 92 Q50 93.5 47.6 92 Z";
const SANS = "Geist, Helvetica Neue, Helvetica, Arial, sans-serif";
const MONO = "Geist Mono, SF Mono, Menlo, monospace";

export type Frame = { state: CardState; elapsedMs: number; frame: number; detail?: string };

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Same units as the dashboard (apps/web/lib/format.ts): "0.6s" under 10 s, then "12s", then "1:05". */
export function clock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** Arc from angle a0 to a1 (degrees, 0 = top, clockwise) on a circle at (cx, cy). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

/** The leaf face (design/gomon/gomon.json) centred at (cx, cy); eyes look by (gx, gy). */
function leaf(cx: number, cy: number, size: number, gx: number, gy: number): string {
  const k = size / 100;
  const eye = (x: number) => `<rect x="${x - 3.2 + gx}" y="${52.5 + gy}" width="6.4" height="15" rx="3.2" fill="#0b2418"/>`;
  return `<g transform="translate(${cx - 50 * k} ${cy - 50 * k}) scale(${k})">
    <path d="${LEAF}" fill="url(#leaf)"/>${eye(42)}${eye(58)}
  </g>`;
}

/** One frame of the camera card as SVG (1280x720). Pure, so tests can check every state without Recall. */
export function cardSvg(f: Frame): string {
  const cx = 410;
  const cy = 350;
  const R = 175;
  const tx = 660;
  let ring = "";
  let under = "";
  let gaze: [number, number] = [0, 0];
  let line = "Say “Hey Gomon” to ask me anything";
  let meter = "";

  if (f.state === "thinking") {
    gaze = [3.5, -3];
    // Three dots under the face, a full one walking left to right.
    const lit = f.frame % 3;
    under = [0, 1, 2].map((i) => `<circle cx="${cx - 30 + i * 30}" cy="${cy + R + 34}" r="8" fill="${GREEN}" fill-opacity="${i === lit ? 1 : 0.22}"/>`).join("");
    line = f.detail?.trim() || "Checking team memory";
    meter = clock(f.elapsedMs);
  } else if (f.state === "speaking") {
    const seq = [0.35, 0.8, 1, 0.5, 0.9, 0.4, 0.7, 0.6];
    under = [0, 1, 2, 3, 4]
      .map((i) => {
        const h = 10 + 30 * seq[(f.frame * 3 + i * 5) % seq.length];
        return `<rect x="${cx - 37 + i * 16}" y="${(cy + R + 34 - h / 2).toFixed(1)}" width="6" height="${h.toFixed(1)}" rx="3" fill="${GREEN}"/>`;
      })
      .join("");
    line = "Answering from team memory";
  } else if (f.state === "locking") {
    // The ring drains over the 10 s veto window.
    const left = Math.max(0, LOCK_MS - f.elapsedMs);
    const sweep = Math.min(359.9, (360 * left) / LOCK_MS);
    ring = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${LINE}" stroke-width="3"/>` +
      (sweep > 0.5 ? `<path d="${arc(cx, cy, R, 0, sweep)}" fill="none" stroke="${GREEN}" stroke-width="5" stroke-linecap="round"/>` : "");
    gaze = [0, 2.5];
    line = "Say “wait” to stop it";
    meter = `${Math.ceil(left / 1000)}s`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="aura" cx="50%" cy="-10%" r="75%"><stop offset="0" stop-color="${GREEN}" stop-opacity=".18"/><stop offset="1" stop-color="${GREEN}" stop-opacity="0"/></radialGradient>
    <linearGradient id="leaf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3cb873"/><stop offset=".55" stop-color="${GREEN}"/><stop offset="1" stop-color="#17864a"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#fbfdfc"/><rect width="${W}" height="${H}" fill="url(#aura)"/>
  ${ring}${leaf(cx, cy, 290, gaze[0], gaze[1])}${under}
  <text x="${tx}" y="262" font-family="${MONO}" font-size="17" letter-spacing="3.4" fill="${FAINT}">DESIGN CALL MEMORY</text>
  <text x="${tx - 5}" y="366" font-family="${SANS}" font-size="104" font-weight="300" letter-spacing="-5" fill="${INK}">Gomon</text>
  <circle cx="${tx + 8}" cy="417" r="13" fill="${GREEN}" fill-opacity=".14"/><circle cx="${tx + 8}" cy="417" r="6" fill="${GREEN}"/>
  <text x="${tx + 34}" y="428" font-family="${SANS}" font-size="32" fill="${MUTED}">${LABEL[f.state]}${meter ? `<tspan font-family="${MONO}" font-size="24" fill="${FAINT}" dx="16">${esc(meter)}</tspan>` : ""}</text>
  <text x="${tx}" y="486" font-family="${SANS}" font-size="27" fill="${INK}">${esc(clip(line, 34))}</text>
</svg>`;
}

type Sharp = (input: Buffer) => { jpeg: (o: { quality: number; mozjpeg?: boolean }) => { toBuffer: () => Promise<Buffer> } };
let sharpP: Promise<Sharp | null> | undefined;
const loadSharp = () =>
  (sharpP ??= import("sharp").then((m) => (m.default ?? m) as unknown as Sharp).catch(() => {
    console.warn("[card] sharp not installed (cd apps/worker && npm i): using the static cards, no animation");
    return null;
  }));

/** JPEG (base64) for one frame; null when sharp is unavailable. */
export async function renderCard(f: Frame): Promise<string | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const buf = await sharp(Buffer.from(cardSvg(f))).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  return buf.toString("base64");
}

// ---------- pushing to the meeting ----------

type Live = { state: CardState; since: number; frame: number; timer?: NodeJS.Timeout; backoffUntil: number };
const live = new Map<string, Live>();
/** One frame on the wire per call at a time, so an old frame can never land after a newer state. */
const busy = new Map<string, Promise<void>>();
/** While audio plays, only "locking" or the end of speech (force) may replace the Speaking card. */
const speakingUntil = new Map<string, number>();

/** A state change waits for the frame on the wire and always goes out; an animation tick is skipped while one is in flight. */
function push(c: Cols, callId: string, l: Live, change: boolean): Promise<void> {
  const prev = busy.get(callId);
  if (prev && !change) return prev;
  const p: Promise<void> = (prev ?? Promise.resolve())
    .then(() => send(c, callId, l, change))
    .catch(() => {})
    .finally(() => {
      if (busy.get(callId) === p) busy.delete(callId);
    });
  busy.set(callId, p);
  return p;
}

async function send(c: Cols, callId: string, l: Live, change: boolean): Promise<void> {
  if (live.get(callId) !== l || (!change && Date.now() < l.backoffUntil)) return;
  const call = await c.calls.findOne({ _id: callId as never }, { projection: { botId: 1, agentState: 1 } });
  const botId = typeof call?.botId === "string" ? call.botId : "";
  if (!botId || !env.recallKey()) return;
  const detail = typeof call?.agentState?.detail === "string" ? call.agentState.detail : undefined;
  const b64 = (await renderCard({ state: l.state, elapsedMs: Date.now() - l.since, frame: l.frame, detail }).catch(() => null)) ?? images[l.state];
  if (live.get(callId) !== l) return; // the state moved on while this frame rendered
  l.frame++;
  const res = await fetch(`https://${env.region()}.recall.ai/api/v1/bot/${botId}/output_video/`, {
    method: "POST",
    headers: { authorization: `Token ${env.recallKey()}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ kind: "jpeg", b64_data: b64 }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (res?.status === 429) l.backoffUntil = Date.now() + 3000;
  // A state change that did not land is retried once (a still Listening card has no next tick to fix it).
  if (change && !res?.ok) setTimeout(() => void push(c, callId, l, true), res?.status === 429 ? 3000 : 1500).unref?.();
}

/** Stop animating a call's card (bot left, worker stopping). */
export function stopCard(callId: string): void {
  const l = live.get(callId);
  if (l?.timer) clearInterval(l.timer);
  live.delete(callId);
  speakingUntil.delete(callId);
}

export async function showCard(c: Cols, callId: string, state: CardState, opts: { forMs?: number; force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (state === "speaking") speakingUntil.set(callId, now + (opts.forMs ?? 3000));
  else if (opts.force) speakingUntil.delete(callId);
  else if (state !== "locking" && (speakingUntil.get(callId) ?? 0) > now) return;
  const prev = live.get(callId);
  if (prev?.state === state) return;
  if (prev?.timer) clearInterval(prev.timer);
  const l: Live = { state, since: now, frame: 0, backoffUntil: prev?.backoffUntil ?? 0 };
  live.set(callId, l);
  const every = FRAME_MS[state];
  if (every > 0) {
    l.timer = setInterval(() => {
      if (live.get(callId) !== l || Date.now() - l.since > MAX_ANIMATE_MS) return void clearInterval(l.timer);
      void push(c, callId, l, false);
    }, every);
    l.timer.unref?.();
  }
  // Thinking ends by itself: when the name is caught on a half-said sentence and no question follows, nothing else would
  // take the dots off the tile (live Nov 14: they ran until someone said stop).
  if (state === "thinking") setTimeout(() => { if (live.get(callId) === l) void showCard(c, callId, "listening", { force: true }); }, THINKING_MAX_MS).unref?.();
  await push(c, callId, l, true);
}
