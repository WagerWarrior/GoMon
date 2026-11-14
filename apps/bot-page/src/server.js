// Gomon bot-page server (zero dependencies, Node >= 20.6).
//   GET  /                 bot page (Recall Output Media camera, or fallback laptop page)
//   POST /recall/webhook/  Recall real-time transcript events -> POST /api/utterances
//   POST /say              worker -> { sayId?, text, priority?, callId? }  (SSE to that call's page, or all pages)
//   POST /say/cancel       drop queued, unspoken output
//   GET  /say/poll         long-poll for the bot page (works through proxies that buffer SSE, e.g. Cloudflare quick tunnels)
//   GET  /say/stream       SSE alternative for clients that can use it
//   POST /page/reload      make connected pages reload themselves (pick up a new page without re-creating the bot)
//   POST /say/ack          page -> { sayId, state: "started" | "done" | "error" | "cancelled" }
//   GET  /tts/:sayId       ElevenLabs streaming TTS proxy (API key never reaches the browser)
//   GET  /health
//
// Worker bridge (apps/worker): utterances go to WORKER_URL/api/utterances, and for every call with a bot page
// this server follows WORKER_URL/api/says/stream?callId= and speaks each say, acking back to
// /api/says/:sayId/ack. The bot page runs in Recall's cloud browser and cannot reach the worker itself.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { toUtterance, segmentBounds, verifyRecallSignature, PARTIAL_EVENT, speechOnParticipant } from "./recall.js";

const PAGE = new URL("../public/index.html", import.meta.url);
const FACE = new URL("../public/gomon-avatar.js", import.meta.url); // Gomon's live face, built by design/gomon

export function configFromEnv(env = process.env) {
  return {
    port: Number(env.BOT_PAGE_PORT || 8787),
    // WORKER_URL="" turns the bridge off (e.g. when testing against scripts/dev-sink.js).
    workerUrl: (env.WORKER_URL ?? "http://localhost:3001").replace(/\/$/, ""),
    workerToken: env.WORKER_TOKEN || "",
    staleSayMs: Number(env.STALE_SAY_MS || 30_000), // worker says older than this are cancelled, not spoken
    // Barge-in: a person starting to talk stops Gomon. BARGE_IN=0 turns it off. The bot's own participant is ignored
    // (matched by name, the bot_name create-bot sets) so Gomon's voice coming back through Meet never stops itself.
    bargeIn: env.BARGE_IN !== "0",
    botName: (env.BOT_NAME || "Gomon").toLowerCase(),
    bargeInDebounceMs: Number(env.BARGE_IN_DEBOUNCE_MS || 1_000),
    utteranceApiUrl: env.UTTERANCE_API_URL || `${(env.WORKER_URL || "http://localhost:3001").replace(/\/$/, "")}/api/utterances`,
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
    ttsRequests: 0, ttsCacheHits: 0, bargeIns: 0, selfSpeech: 0 };
  const lastStop = new Map();     // callId -> ms of the last barge-in stop (debounce)
  const bridges = new Map();     // callId -> { ctrl, connected } : following the worker's says stream
  const workerSays = new Set();  // sayIds that came from the worker (dedup replays, route acks back)
  const waiting = new Map();     // callId -> says that arrived while no page for that call was connected
  const workerHeaders = (extra = {}) => ({ ...(cfg.workerToken ? { authorization: `Bearer ${cfg.workerToken}` } : {}), ...extra });
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
    for (const c of clients) {
      if (callId && c.callId !== callId) continue;
      if (c.polling) c.push({ event, data }); else c.write(msg);
      n++;
    }
    return n;
  };

  // Long-poll clients: the page asks, the server answers as soon as there is something to say (or after 20 s).
  const pollers = new Map(); // client id -> { callId, queue, waiter, seenAt }
  function poller(id, callId) {
    let c = pollers.get(id);
    if (!c) {
      c = { polling: true, callId, queue: [], waiter: null, seenAt: Date.now(),
        push(ev) { this.queue.push(ev); if (this.waiter) this.waiter(); },
        end() { if (this.waiter) this.waiter(); } };
      pollers.set(id, c);
      clients.add(c);
      log(`page connected (call ${callId ?? "-"}, polling); ${clients.size} page(s)`);
      if (callId) { ensureBridge(callId); flushWaiting(callId); }
    }
    c.seenAt = Date.now();
    return c;
  }
  const sweep = setInterval(() => {
    for (const [id, c] of pollers) {
      if (c.waiter || Date.now() - c.seenAt < 35_000) continue; // a held request, or it asked recently
      pollers.delete(id); clients.delete(c);
      log(`page disconnected (call ${c.callId ?? "-"}, polling); ${clients.size} page(s)`);
    }
  }, 10_000);
  sweep.unref();

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

  function enqueueSay({ sayId, text, priority = "normal", callId, from = "api" }) {
    const now = Date.now();
    for (const [id, p] of pending) if (now - p.createdAt > 10 * 60_000) pending.delete(id);
    if (!pending.has(sayId)) pending.set(sayId, { text, priority, callId, from, createdAt: now, tts: ttsReady() ? startTts(text, sayId) : null });
    const pages = broadcast("say", { sayId, text, priority }, callId);
    log(`say ${sayId} (${from}, ${priority}${callId ? `, call ${callId}` : ""}) -> ${pages} page(s): ${text.slice(0, 80)}`);
    return pages;
  }

  function ackWorker(sayId, state) {
    const status = state === "error" ? "failed" : state; // worker accepts started|done|failed|cancelled
    fetch(`${cfg.workerUrl}/api/says/${encodeURIComponent(sayId)}/ack`, {
      method: "POST", headers: workerHeaders({ "content-type": "application/json" }), body: JSON.stringify({ status }),
    }).then((r) => { if (!r.ok) log(`worker ack ${sayId} ${status} -> ${r.status}`); })
      .catch((e) => log(`worker ack ${sayId} failed: ${e.message}`));
  }

  function onWorkerSay(callId, say) {
    if (!say?.sayId || typeof say.text !== "string" || workerSays.has(say.sayId)) return; // the stream replays queued says
    workerSays.add(say.sayId);
    // The stream replays every say still marked queued. After a restart or an outage those can be minutes old;
    // speaking them then would be worse than silence, so they are cancelled instead.
    const ageMs = say.createdAt ? Date.now() - Date.parse(say.createdAt) : 0;
    if (ageMs > cfg.staleSayMs) {
      log(`say ${say.sayId} skipped: ${Math.round(ageMs / 1000)} s old`);
      return ackWorker(say.sayId, "cancelled");
    }
    const item = { sayId: say.sayId, text: say.text, priority: say.priority === "high" ? "high" : "normal", callId, from: "worker" };
    if (enqueueSay(item) === 0) { // no page for this call right now: hold it until one connects
      if (!waiting.has(callId)) waiting.set(callId, []);
      waiting.get(callId).push(item);
    }
  }

  function flushWaiting(callId) {
    const held = waiting.get(callId);
    if (!held) return;
    waiting.delete(callId);
    for (const item of held) {
      const p = pending.get(item.sayId);
      if (p && Date.now() - p.createdAt < 30_000) enqueueSay(item);
      else { pending.delete(item.sayId); ackWorker(item.sayId, "cancelled"); log(`say ${item.sayId} dropped: no page for 30 s`); }
    }
  }

  // Follow the worker's SSE of says for one call; reconnect forever with backoff, logging only on state changes.
  function ensureBridge(callId) {
    if (!cfg.workerUrl || !callId || bridges.has(callId)) return;
    const b = { ctrl: new AbortController(), connected: null };
    bridges.set(callId, b);
    (async () => {
      let delay = 500;
      while (!b.ctrl.signal.aborted) {
        try {
          const r = await fetch(`${cfg.workerUrl}/api/says/stream?callId=${encodeURIComponent(callId)}`,
            { headers: workerHeaders({ accept: "text/event-stream" }), signal: b.ctrl.signal });
          if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
          if (b.connected !== true) log(`worker says stream connected (call ${callId})`);
          b.connected = true; delay = 500;
          const dec = new TextDecoder();
          let buf = "";
          for await (const chunk of r.body) {
            buf += dec.decode(chunk, { stream: true });
            for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
              const block = buf.slice(0, i);
              const data = /^data: (.*)$/m.exec(block)?.[1];
              if (/^event: say$/m.test(block) && data) { try { onWorkerSay(callId, JSON.parse(data)); } catch { /* bad frame */ } }
            }
          }
          throw new Error("stream ended");
        } catch (e) {
          if (b.ctrl.signal.aborted) break;
          if (b.connected !== false) log(`worker says stream unavailable (call ${callId}): ${e.message}; retrying`);
          b.connected = false;
          await sleep(delay);
          delay = Math.min(delay * 2, 5000);
        }
      }
    })();
  }

  async function deliver(u) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const t0 = performance.now();
      try {
        const r = await fetch(cfg.utteranceApiUrl, {
          method: "POST", headers: workerHeaders({ "content-type": "application/json" }), body: JSON.stringify(u),
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
    if (req.method === "GET" && pathname === "/gomon-avatar.js") {
      return send(res, 200, await readFile(FACE, "utf8"), { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" });
    }
    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, {
        ok: true, pages: clients.size, calls: [...clients].map((c) => c.callId), pending: pending.size, tts: Boolean(cfg.elKey && cfg.elVoice),
        webhookAuth: cfg.webhookSecret ? "signature" : cfg.webhookToken ? "token" : "none",
        worker: cfg.workerUrl ? Object.fromEntries([...bridges].map(([id, b]) => [id, b.connected ? "connected" : "retrying"])) : "off",
        stats,
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
      const speaker = speechOnParticipant(body);
      if (speaker) {
        if (!cfg.bargeIn || !callId) return;
        if (speaker.name.trim().toLowerCase() === cfg.botName) { stats.selfSpeech++; return; } // Gomon hearing itself
        if (receivedAt - (lastStop.get(callId) ?? 0) < cfg.bargeInDebounceMs) return;
        lastStop.set(callId, receivedAt);
        stats.bargeIns++;
        const pages = broadcast("stop", { reason: "barge_in", speaker: speaker.name }, callId);
        return log(`barge-in by ${speaker.name || "unknown"} -> stop to ${pages} page(s) (call ${callId})`);
      }
      if (!callId) return log("recall webhook: no callId (query or bot.metadata) — ignored");
      ensureBridge(callId);
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
      return send(res, 202, { sayId, pages: enqueueSay({ sayId, text, priority, callId }) });
    }
    if (req.method === "POST" && pathname === "/say/cancel") {
      if (!tokenOk(req, url, cfg.sayToken)) return send(res, 401, { error: "bad token" });
      const { callId } = await readJson(req);
      return send(res, 202, { ok: true, pages: broadcast("cancel", {}, callId) });
    }
    if (req.method === "GET" && pathname === "/say/poll") {
      const id = url.searchParams.get("client") || "";
      if (!/^[\w-]{6,64}$/.test(id)) return send(res, 400, { error: "client id required" });
      const c = poller(id, url.searchParams.get("callId") || null);
      if (c.waiter) c.waiter(); // a newer request from the same page replaces the held one
      let gone = false, mine = true;
      if (!c.queue.length) {
        let done;
        const wait = new Promise((ok) => { const t = setTimeout(ok, 20_000); done = () => { clearTimeout(t); ok(); }; });
        c.waiter = done;
        req.on("close", () => { gone = true; done(); });
        await wait;
        mine = c.waiter === done;      // false when a newer request took over while this one was held
        if (mine) c.waiter = null;
      }
      c.seenAt = Date.now();
      if (gone || res.destroyed) return; // keep the queue for the page's next request
      return send(res, 200, { events: mine ? c.queue.splice(0) : [] }, { "cache-control": "no-store" });
    }
    if (req.method === "POST" && pathname === "/page/reload") {
      if (!tokenOk(req, url, cfg.sayToken)) return send(res, 401, { error: "bad token" });
      const { callId } = await readJson(req);
      return send(res, 202, { pages: broadcast("reload", {}, callId) });
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
      if (res.callId) { ensureBridge(res.callId); flushWaiting(res.callId); }
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); log(`page disconnected (call ${res.callId ?? "-"}); ${clients.size} page(s)`); });
      return;
    }
    if (req.method === "POST" && pathname === "/page/report") { // layout diagnostics from the bot's browser
      log(`page report ${(await readRaw(req, 20_000)).slice(0, 4000)}`);
      return send(res, 204, "");
    }
    if (req.method === "POST" && pathname === "/say/ack") {
      const ack = await readJson(req);
      const p = pending.get(ack.sayId);
      const sinceSayMs = p ? Date.now() - p.createdAt : null;
      log(`ack ${ack.sayId} ${ack.state}${sinceSayMs != null ? ` +${sinceSayMs}ms since /say` : ""}`);
      if (["done", "error", "cancelled"].includes(ack.state)) pending.delete(ack.sayId);
      if (workerSays.has(ack.sayId) && ["started", "done", "error", "cancelled"].includes(ack.state)) ackWorker(ack.sayId, ack.state);
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
  server.closeClients = () => {
    clearInterval(sweep);
    for (const c of clients) c.end();
    clients.clear(); pollers.clear();
    for (const b of bridges.values()) b.ctrl.abort();
  };
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = configFromEnv();
  createServer(cfg).listen(cfg.port, () =>
    cfg.log(`bot-page on :${cfg.port}; utterances -> ${cfg.utteranceApiUrl}; worker says: ${cfg.workerUrl || "off"}; webhook auth: ${
      cfg.webhookSecret ? "signature" : cfg.webhookToken ? "token" : "NONE"}`));
}
