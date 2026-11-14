"use client";
/**
 * Gomon's ears inside the session page: captures the Google Meet tab (everyone remote) and this laptop's mic, streams each
 * to ElevenLabs Scribe realtime (outbound WebSocket, no tunnel) and posts committed sentences to the worker as utterances.
 * Same behaviour as the worker's /ears page: turn-prediction commits, an early commit when Gomon is addressed, a short
 * mic delay so the meeting copy wins duplicates, and live level meters.
 */
import { useEffect, useRef, useState } from "react";

type Channel = "meeting" | "mic";
type Status = { text: string; tone: "off" | "live" | "err" };
type Entry = { channel: Channel; media: MediaStream; ws: WebSocket; lastCommit: number; turnStart?: number; lastPartial?: number };
type ScribeEvent = { message_type: string; text?: string; turn_probability?: number; error?: string; message?: string };

const RATE = 16000;
const MODEL = "scribe_v3_live";
const WORKLET = `class Pcm extends AudioWorkletProcessor { process(i) { const c = i[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } } registerProcessor("pcm", Pcm);`;

function toPcm16(input: Float32Array, fromRate: number): Int16Array {
  const ratio = fromRate / RATE, n = Math.floor(input.length / ratio), out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0;
    const s = (input[i0] ?? 0) * (1 - f) + (input[i0 + 1] ?? input[i0] ?? 0) * f;
    out[i] = Math.max(-1, Math.min(1, s)) * 0x7fff;
  }
  return out;
}
function b64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export default function Listen({ callId, defaultMe, defaultRemote }: { callId: string; defaultMe: string; defaultRemote: string }) {
  const [running, setRunning] = useState(false);
  const [me, setMe] = useState(defaultMe);
  const [remote, setRemote] = useState(defaultRemote);
  const [status, setStatus] = useState<Record<Channel, Status>>({ meeting: { text: "off", tone: "off" }, mic: { text: "off", tone: "off" } });
  const [last, setLast] = useState("");
  const ctxRef = useRef<AudioContext | null>(null);
  const entries = useRef<Entry[]>([]);
  const names = useRef({ me, remote });
  names.current = { me, remote };
  const runningRef = useRef(false);

  const set = (ch: Channel, text: string, tone: Status["tone"]) => setStatus((s) => ({ ...s, [ch]: { text, tone } }));

  async function connect(channel: Channel): Promise<WebSocket> {
    const r = await fetch("/api/ears/token");
    const { token, keyterms } = (await r.json()) as { token?: string; keyterms?: string[] };
    if (!token) throw new Error("no Scribe token (is the worker running?)");
    const p = new URLSearchParams({ model_id: MODEL, token, audio_format: "pcm_16000", commit_strategy: "turn_prediction", vad_silence_threshold_secs: "0.6" });
    // The team's names from Atlas (worker people.ts), so Scribe spells people, logins and projects right.
    for (const k of keyterms?.length ? keyterms : ["Gomon"]) p.append("keyterms", k);
    const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${p}`);
    ws.onmessage = async (m: MessageEvent<string>) => {
      const e = JSON.parse(m.data) as ScribeEvent;
      const self = entries.current.find((x) => x.ws === ws);
      if (e.message_type === "partial_transcript") {
        const n = (e.text ?? "").split(/\s+/).filter(Boolean).length;
        const addressed = /\bgo\s?mon\b/i.test(e.text ?? "");
        // Barge-in: the worker stops Gomon when a person says "stop" or talks over it (worker floor.ts). Never stored.
        if (self && n) {
          self.turnStart ??= performance.now();
          if (performance.now() - (self.lastPartial ?? 0) > 250) {
            self.lastPartial = performance.now();
            void fetch("/api/ears/partial", { method: "POST", body: JSON.stringify({ callId, text: e.text, ms: Math.round(performance.now() - self.turnStart), channel }) }).catch(() => {});
          }
        } else if (self) self.turnStart = undefined;
        if (self && n && (n >= 30 || (addressed && (e.turn_probability ?? 0) >= 0.5)) && performance.now() - self.lastCommit > 2000) {
          self.lastCommit = performance.now();
          ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: RATE }));
        }
      } else if (e.message_type === "committed_transcript" && e.text?.trim()) {
        const speaker = channel === "mic" ? names.current.me : names.current.remote;
        if (self) self.turnStart = undefined;
        if (channel === "mic") await new Promise((res) => setTimeout(res, 700));
        await fetch("/api/ears/utterance", { method: "POST", body: JSON.stringify({ callId, speaker, text: e.text, channel }) });
        setLast(`${speaker}: ${e.text}`);
      } else if (e.error || /error|limit|exceeded|throttled/.test(e.message_type)) {
        set(channel, `${e.message_type}: ${e.error ?? e.message ?? ""}`, "err");
      }
    };
    return ws;
  }

  async function startChannel(channel: Channel, media: MediaStream, ctx: AudioContext) {
    const src = ctx.createMediaStreamSource(media);
    const node = new AudioWorkletNode(ctx, "pcm");
    const entry: Entry = { channel, media, ws: await connect(channel), lastCommit: 0 };
    entries.current.push(entry);
    // Scribe sessions can end (limits, network); reconnect with a fresh token while listening.
    const attach = (ws: WebSocket) => {
      ws.onclose = () => {
        if (!runningRef.current) return;
        set(channel, "reconnecting…", "err");
        setTimeout(() => { if (runningRef.current) void connect(channel).then((n) => { entry.ws = n; attach(n); }).catch((err) => set(channel, String(err), "err")); }, 800);
      };
    };
    attach(entry.ws);
    let buf: Float32Array[] = [], pending = 0, peak = 0, shownAt = 0;
    node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      buf.push(data); pending += data.length;
      for (let i = 0; i < data.length; i += 8) peak = Math.max(peak, Math.abs(data[i]));
      if (pending < ctx.sampleRate / 10) return;
      const all = new Float32Array(pending); let o = 0;
      for (const b of buf) { all.set(b, o); o += b.length; }
      buf = []; pending = 0;
      if (entry.ws.readyState !== WebSocket.OPEN) return;
      entry.ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64(toPcm16(all, ctx.sampleRate)), commit: false, sample_rate: RATE }));
      if (performance.now() - shownAt > 500) {
        set(channel, `${"▮".repeat(Math.min(8, Math.round(peak * 25)))}${peak < 0.003 ? " silent" : ""}`, "live");
        shownAt = performance.now(); peak = 0;
      }
    };
    src.connect(node);
    node.connect(ctx.destination);
    media.getAudioTracks()[0].onended = () => set(channel, "source ended", "err");
  }

  async function start() {
    // Create and resume the AudioContext inside the click: created after an await, Chrome keeps it suspended (silence).
    const ctx = new AudioContext();
    void ctx.resume();
    ctxRef.current = ctx;
    const ready = ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
    runningRef.current = true; setRunning(true);
    try {
      const tab = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false } });
      await ready;
      if (tab.getAudioTracks().length) { tab.getVideoTracks().forEach((t) => { t.enabled = false; }); await startChannel("meeting", tab, ctx); }
      else set("meeting", "no tab audio: pick the Meet tab, keep 'Also share tab audio' on", "err");
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      await startChannel("mic", mic, ctx);
      if (ctx.state !== "running") await ctx.resume();
    } catch (err) { setLast(`error: ${String(err)}`); }
  }
  function stop() {
    runningRef.current = false; setRunning(false);
    for (const e of entries.current.splice(0)) { e.ws.close(); e.media.getTracks().forEach((t) => t.stop()); set(e.channel, "off", "off"); }
    void ctxRef.current?.close(); ctxRef.current = null;
  }
  useEffect(() => () => stop(), []);

  const dot = (s: Status) => <span className={`ls-dot ls-${s.tone}`} title={s.text} />;
  return (
    <div className="ls">
      <button className={`ls-btn ${running ? "on" : ""}`} onClick={() => (running ? stop() : start())}>{running ? "■ Stop listening" : "● Listen to this meeting"}</button>
      {running ? (
        <span className="ls-meters">{dot(status.meeting)} meeting {status.meeting.text} · {dot(status.mic)} you {status.mic.text}</span>
      ) : (
        <span className="ls-names">you <input value={me} onChange={(e) => setMe(e.target.value)} /> others <input value={remote} onChange={(e) => setRemote(e.target.value)} /></span>
      )}
      {last && <span className="ls-last" title={last}>{last}</span>}
    </div>
  );
}
