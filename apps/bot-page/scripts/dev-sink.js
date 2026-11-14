// Local stand-in for POST /api/utterances so the bot page can be tested before the real API is up.
// Prints every utterance, flags duplicate sourceKeys with 409 (the proposed contract), and serves
// GET /utterances for inspection. Usage: npm run sink   (port SINK_PORT, default 3999)
//
// SINK_AUTOREPLY=1 adds a test responder: when an utterance addresses Gomon (see src/wake.js) it calls
// POST /say with a line that starts "Test reply", so the full loop speech -> utterance -> say -> audio can
// be tried in a Meet before the real agent is connected. It is a dev tool, not the agent; never demo it.
import http from "node:http";
import { parseWake } from "../src/wake.js";

const port = Number(process.env.SINK_PORT || 3999);
const AUTOREPLY = process.env.SINK_AUTOREPLY === "1";
const SAY_URL = process.env.SAY_URL || `http://localhost:${process.env.BOT_PAGE_PORT || 8787}/say`;
const seen = new Map();

function autoReply(u) {
  if (u.speaker.displayName === "Gomon") return; // never answer our own voice
  const w = parseWake(u.text);
  if (!w.addressed) return;
  const first = u.speaker.displayName.split(" ")[0];
  const text = w.rest ? `Test reply, ${first}. I heard: ${w.rest}.` : `Test reply. Yes ${first}, I'm here.`;
  const headers = { "content-type": "application/json" };
  if (process.env.SAY_TOKEN) headers.authorization = `Bearer ${process.env.SAY_TOKEN}`;
  fetch(SAY_URL, { method: "POST", headers, body: JSON.stringify({ text, priority: "high", callId: u.callId }) })
    .then(async (r) => console.log(`   ↳ addressed (heard "${w.heardAs}") -> /say ${r.status} ${await r.text()}`))
    .catch((e) => console.log(`   ↳ auto-reply failed: ${e.message}`));
}
const all = [];

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url.startsWith("/utterances")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(all, null, 2));
  }
  if (req.method !== "POST") { res.writeHead(404); return res.end(); }
  let b = ""; for await (const c of req) b += c;
  let u;
  try { u = JSON.parse(b); } catch { res.writeHead(400); return res.end("bad json"); }
  const missing = ["callId", "sourceKey", "text", "source"].filter((k) => !u[k]);
  if (missing.length || !u.speaker?.displayName) {
    console.log("400 missing", missing.concat(u.speaker?.displayName ? [] : ["speaker.displayName"]));
    res.writeHead(400); return res.end(JSON.stringify({ missing }));
  }
  if (seen.has(u.sourceKey)) { console.log(`409 dup ${u.sourceKey}`); res.writeHead(409); return res.end("{}"); }
  seen.set(u.sourceKey, u);
  all.push({ ...u, receivedAt: new Date().toISOString() });
  console.log(`#${all.length} [${u.speaker.displayName}] ${u.text}   (${u.startedAt ?? "-"} → ${u.endedAt ?? "-"}) ${u.sourceKey}`);
  res.writeHead(201, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, n: all.length }));
  if (AUTOREPLY) autoReply(u);
}).listen(port, () => console.log(`utterance sink on :${port} (POST any path, GET /utterances)${AUTOREPLY ? "; test responder ON" : ""}`));
