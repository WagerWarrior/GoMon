// Gomon bot-page server (zero dependencies, Node >= 20.6).
//   GET  /                 bot page (Recall Output Media camera, or fallback laptop page)
//   POST /recall/webhook/  Recall real-time transcript events -> POST /api/utterances
//   POST /say              worker -> { sayId?, text, priority?, callId? }  (SSE to that call's page, or all pages)
//   POST /say/cancel       drop queued, unspoken output
//   GET  /say/stream       SSE to the bot page
//   POST /say/ack          page -> { sayId, state: "started" | "done" | "error" | "cancelled" }
//   GET  /tts/:sayId       ElevenLabs streaming TTS proxy (API key never reaches the browser)
//   GET  /health
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { toUtterance, segmentBounds, verifyRecallSignature, PARTIAL_EVENT } from "./recall.js";

const PAGE = new URL("../public/index.html", import.meta.url);

export function configFromEnv(env = process.env) {
  return {
    port: Number(env.BOT_PAGE_PORT || 8787),
    utteranceApiUrl: env.UTTERANCE_API_URL || "http://localhost:3000/api/utterances",
    webhookSecret: env.RECALL_WEBHOOK_SECRET || "", // whsec_... (preferred; Recall signs every request)
    webhookToken: env.RECALL_WEBHOOK_TOKEN || "",   // ?token= fallback when no workspace secret exists
    sayToken: env.SAY_TOKEN || "",
    sayAckUrl: env.SAY_ACK_URL || "",
    elKey: env.ELEVENLABS_API_KEY || "",
    elVoice: env.ELEVENLABS_VOICE_ID || "",
    elModel: env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5",
    elBaseUrl: env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io",
    // The bot's output is 16 kHz mono (Recall), so a light format loses nothing there and starts sooner.
    elFormat: env.ELEVENLABS_OUTPUT_FORMAT || "mp3_22050_32",
    sayPrecache: (env.SAY_PRECACHE || "").split("|").map((t) => t.trim()).filter(Boolean), // e.g. "On it.|One moment."
    log: (...a) => console.log(new Date().toISOString(), ...a),
  };
}

function safeEq(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function tokenOk(req, url, secret) {
  if (!secret) return true; // unset in local dev
  const got = url.searchParams.get("token") || (req.headers.authorization || "").replace(/^Bearer /, "");
  return safeEq(got, secret);
}
async function readRaw(req, limit = 1_000_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error("body too large"); chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}
async function readJson(req) {
  const raw = await readRaw(req);
  return raw ? JSON.parse(raw) : {};
}
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string";
  res.writeHead(status, { "content-type": isJson ? "application/json" : "text/plain", ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function createServer(cfg = configFromEnv()) {
  const { log } = cfg;
  const clients = new Set();     // SSE responses
  const pending = new Map();     // sayId -> { text, priority, createdAt }
  const anchors = new Map();     // botId -> estimated wall-clock ms of recording t=0
  const seen = new Set();        // sourceKeys already delivered (or in flight)
  const stats = { webhooks: 0, finals: 0, partials: 0, duplicates: 0, delivered: 0, failed: 0, rejected: 0,
    ttsRequests: 0, ttsCacheHits: 0 };
  const ttsCache = new Map();    // text -> Buffer (finished audio), oldest first
  const ttsReady = () => Boolean(cfg.elKey && cfg.elVoice);

  // Start ElevenLabs the moment a line is requested, not when the page asks for it: the page's request then
  // finds audio already arriving. Finished audio is cached by text, so a repeated line needs no request at all.
  function startTts(text, label) {
    const hit = ttsCache.get(text);
    if (hit) { stats.ttsCacheHits++; return { chunks: [hit], done: true, error: null, waiters: new Set() }; }
    const job = { chunks: [], done: false, error: null, waiters: new Set() };
    const wake = () => { for (const w of job.waiters) w(); job.waiters.clear(); };
    const t0 = performance.now();
    stats.ttsRequests++;
    (async () => {
      try {
        const r = await fetch(
          `${cfg.elBaseUrl}/v1/text-to-speech/${encodeURIComponent(cfg.elVoice)}/stream?output_format=${cfg.elFormat}`,
          {
            method: "POST",
            headers: { "xi-api-key": cfg.elKey, "content-type": "application/json", accept: "audio/mpeg" },
            body: JSON.stringify({ text, model_id: cfg.elModel }),
          },
        );
        if (!r.ok || !r.body) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
        for await (const chunk of r.body) {
          if (!job.chunks.length) log(`tts ${label} first byte ${Math.round(performance.now() - t0)}ms`);
          job.chunks.push(Buffer.from(chunk));
          wake();
        }
        job.done = true;
        ttsCache.set(text, Buffer.concat(job.chunks));
        if (ttsCache.size > 100) ttsCache.delete(ttsCache.keys().next().value);
      } catch (e) {
        job.error = e.message;
        log(`tts ${label} failed: ${e.message}`);
      }
      wake();
    })();
    return job;
  }

  // callId given -> only pages opened for that call; omitted -> every connected page. Returns pages reached.
  const broadcast = (event, data, callId) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let n = 0;
    for (const c of clients) if (!callId || c.callId === callId) { c.write(msg); n++; }
    return n;
  };

  // Recall sends relative seconds only. Fix t=0 per bot from its first final segment (receivedAt - segmentEnd).
  // One fixed anchor keeps every utterance on the same clock, so order always matches Recall's relative times;
  // absolute error is that first segment's transcript latency (docs: typically 1-3 s in low-latency mode).
  function anchorFor(body, receivedAt) {
    const botId = body.data?.bot?.id ?? "nobot";
    if (!anchors.has(botId)) {
      const b = segmentBounds(body);
      if (!b) return null;
      anchors.set(botId, receivedAt - b.end * 1000);
    }
    return anchors.get(botId);
  }

  async function deliver(u) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const t0 = performance.now();
      try {
        const r = await fetch(cfg.utteranceApiUrl, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(u),
        });
        const ms = Math.round(performance.now() - t0);
        log(`utterance ${r.status} ${ms}ms [${u.speaker.displayName}] ${u.text.slice(0, 80)}`);
        if (r.ok || r.status === 409) { stats.delivered++; return; } // 409 = duplicate sourceKey downstream
        if (r.status >= 400 && r.status < 500) break;                // contract error: retrying won't help
      } catch (e) {
        log(`utterance post attempt ${attempt} failed: ${e.message}`);
      }
      await sleep(250 * 2 ** (attempt - 1));
    }
    stats.failed++;
    seen.delete(u.sourceKey); // let a later Recall retry (if any) try again
    log(`utterance DROPPED ${u.sourceKey}`);
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return send(res, 200, await readFile(PAGE, "utf8"), { "content-type": "text/html; charset=utf-8" });
    }
    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, {
        ok: true, pages: clients.size, calls: [...clients].map((c) => c.callId), pending: pending.size, tts: Boolean(cfg.elKey && cfg.elVoice),
        webhookAuth: cfg.webhookSecret ? "signature" : cfg.webhookToken ? "token" : "none", stats,
      });
    }

    if (req.method === "POST" && pathname === "/recall/webhook") {
      const receivedAt = Date.now();
      stats.webhooks++;
      const raw = await readRaw(req);
      if (cfg.webhookSecret) {
        const v = verifyRecallSignature({ secret: cfg.webhookSecret, headers: req.headers, rawBody: raw });
        if (!v.ok) { stats.rejected++; log(`recall webhook REJECTED: ${v.reason}`); return send(res, 401, { error: v.reason }); }
      } else if (!tokenOk(req, url, cfg.webhookToken)) {
        stats.rejected++; log("recall webhook REJECTED: bad token"); return send(res, 401, { error: "bad token" });
      }
      // Always 200 from here: Recall retries non-2xx 60x at 1 s, then marks the endpoint failed for the call.
      send(res, 200, { ok: true });
      let body;
      try { body = JSON.parse(raw); } catch { return log("recall webhook: invalid JSON ignored"); }
      if (body.event === PARTIAL_EVENT) { stats.partials++; return; } // partial text never becomes an utterance
      const callId = url.searchParams.get("callId") || body.data?.bot?.metadata?.callId;
      if (!callId) return log("recall webhook: no callId (query or bot.metadata) — ignored");
      const u = toUtterance(body, callId, { anchorMs: anchorFor(body, receivedAt) });
      if (!u) return log(`recall event ignored: ${body.event}`);
      stats.finals++;
      if (seen.has(u.sourceKey)) { stats.duplicates++; return log(`duplicate ${u.sourceKey} ignored`); }
      seen.add(u.sourceKey);
      deliver(u);
      return;
    }

    if (req.method === "POST" && pathname === "/say") {
      if (!tokenOk(req, url, cfg.sayToken)) return send(res, 401, { error: "bad token" });
      const { sayId = randomUUID(), text, priority = "normal", callId } = await readJson(req);
      if (!text || typeof text !== "string") return send(res, 400, { error: "text required" });
      if (!/^[\w-]{1,128}$/.test(sayId)) return send(res, 400, { error: "sayId must match [\\w-]{1,128}" });
      const now = Date.now();
      for (const [id, p] of pending) if (now - p.createdAt > 10 * 60_000) pending.delete(id);
      pending.set(sayId, { text, priority, createdAt: now, tts: ttsReady() ? startTts(text, sayId) : null });
      const pages = broadcast("say", { sayId, text, priority }, callId);
      log(`say ${sayId} (${priority}${callId ? `, call ${callId}` : ""}) -> ${pages} page(s): ${text.slice(0, 80)}`);
      return send(res, 202, { sayId, pages });
    }
    if (req.method === "POST" && pathname === "/say/cancel") {
      if (!tokenOk(req, url, cfg.sayToken)) return send(res, 401, { error: "bad token" });
      const { callId } = await readJson(req);
      return send(res, 202, { ok: true, pages: broadcast("cancel", {}, callId) });
    }
    if (req.method === "GET" && pathname === "/say/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform",
        connection: "keep-alive", "x-accel-buffering": "no" });
      // Which call this page serves: explicit ?callId=, else the callId on the page URL (Referer).
      let refCallId = null;
      try { refCallId = new URL(req.headers.referer).searchParams.get("callId"); } catch { /* no referer */ }
      res.callId = url.searchParams.get("callId") || refCallId || null;
      res.write(": connected\n\n");
      clients.add(res);
      log(`page connected (call ${res.callId ?? "-"}); ${clients.size} page(s)`);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); log(`page disconnected (call ${res.callId ?? "-"}); ${clients.size} page(s)`); });
      return;
    }
    if (req.method === "POST" && pathname === "/say/ack") {
      const ack = await readJson(req);
      const p = pending.get(ack.sayId);
      const sinceSayMs = p ? Date.now() - p.createdAt : null;
      log(`ack ${ack.sayId} ${ack.state}${sinceSayMs != null ? ` +${sinceSayMs}ms since /say` : ""}`);
      if (["done", "error", "cancelled"].includes(ack.state)) pending.delete(ack.sayId);
      if (cfg.sayAckUrl) {
        fetch(cfg.sayAckUrl, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...ack, sinceSayMs, at: new Date().toISOString() }),
        }).catch((e) => log("ack forward failed:", e.message));
      }
      return send(res, 204, "");
    }

    const tts = pathname.match(/^\/tts\/([\w-]+)$/);
    if (req.method === "GET" && tts) {
      const p = pending.get(tts[1]);
      if (!p) return send(res, 404, { error: "unknown sayId" });
      if (!p.tts) return send(res, 503, { error: "ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set" });
      const job = p.tts;
      const next = () => new Promise((ok) => job.waiters.add(ok));
      while (!job.chunks.length && !job.error && !job.done) await next();
      if (!job.chunks.length) return send(res, 502, { error: job.error || "no audio" });
      res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store" });
      for (let i = 0; !res.destroyed; ) {
        while (i < job.chunks.length && !res.destroyed) {
          if (!res.write(job.chunks[i++])) await new Promise((ok) => { res.once("drain", ok); res.once("close", ok); });
        }
        if (job.done || job.error) break;
        await next();
      }
      return res.end();
    }

    send(res, 404, { error: "not found" });
  }

  const server = http.createServer((req, res) =>
    handle(req, res).catch((e) => {
      log("error", req.method, req.url, e.message);
      if (!res.headersSent) send(res, e instanceof SyntaxError ? 400 : 500, { error: e.message }); else res.end();
    }),
  );
  server.stats = stats;
  if (ttsReady()) for (const text of cfg.sayPrecache) startTts(text, "precache");
  server.closeClients = () => { for (const c of clients) c.end(); clients.clear(); };
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = configFromEnv();
  createServer(cfg).listen(cfg.port, () =>
    cfg.log(`bot-page on :${cfg.port}; utterances -> ${cfg.utteranceApiUrl}; webhook auth: ${
      cfg.webhookSecret ? "signature" : cfg.webhookToken ? "token" : "NONE"}`));
}
