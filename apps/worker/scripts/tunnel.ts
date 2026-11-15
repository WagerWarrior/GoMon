/**
 * Public URL for Recall's join/leave events, so Gomon knows who is in the Meet (roster.ts). Opens a free tunnel (no
 * account) to the events server only (127.0.0.1:3011, never the worker's API) and writes the URL to .local/tunnel-url,
 * where the next bot sent into a meeting picks it up. Ctrl-C removes the file.
 *   npm run tunnel        start it before sending Gomon into the meeting
 * Providers, in order: Cloudflare quick tunnel (`brew install cloudflared`), then localhost.run over ssh (nothing to
 * install). Nov 15: on the venue Wi-Fi Cloudflare answered 429 for minutes; localhost.run worked at once.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { TUNNEL_FILE } from "../src/recall.ts";

const port = Number(process.env.EVENTS_PORT || 3011);
const target = `127.0.0.1:${port}`;
const PROBE_MS = 20_000;
const PROVIDERS = [
  { name: "cloudflare", cmd: "cloudflared", args: ["tunnel", "--no-autoupdate", "--url", `http://${target}`], url: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ },
  { name: "localhost.run", cmd: "ssh", args: ["-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes", "-R", `80:${target}`, "nokey@localhost.run"], url: /https:\/\/[a-z0-9-]+(\.app)?\.lhr\.life/ },
];
let cf: ChildProcess | null = null, stopping = false;

function run(i: number): void {
  const p = PROVIDERS[i];
  let url = "";
  cf = spawn(p.cmd, p.args, { stdio: ["ignore", "pipe", "pipe"] });
  const scan = (d: Buffer) => {
    for (const line of String(d).split("\n")) if (/\bERR\b|failed|denied/i.test(line)) console.log(`[${p.name}] ${line.trim()}`);
    const m = p.url.exec(String(d));
    if (!m || url) return;
    url = m[0];
    mkdirSync(dirname(TUNNEL_FILE), { recursive: true });
    writeFileSync(TUNNEL_FILE, `${url}\n`);
    console.log(`[tunnel] ${url} -> ${target} via ${p.name} (written to ${TUNNEL_FILE}); bots sent from now on report who joins`);
    watch(url);
  };
  // A tunnel can stop forwarding while its process lives on (Nov 15: localhost.run answered 502 for a live call's join
  // events, ssh still connected). The events server answers 401 to a tokenless POST; anything else twice in a row is dead.
  let probe: NodeJS.Timeout | undefined, misses = 0;
  const watch = (u: string) => {
    probe = setInterval(async () => {
      const code = await fetch(`${u}/recall/events/`, { method: "POST", signal: AbortSignal.timeout(8000) }).then((r) => r.status).catch(() => 0);
      misses = code === 401 ? 0 : misses + 1;
      if (misses >= 2) { console.log(`[tunnel] ${u} stopped forwarding (${code || "no answer"} twice); replacing it`); clearInterval(probe); cf?.kill(); }
    }, PROBE_MS);
  };
  cf.stdout?.on("data", scan);
  cf.stderr?.on("data", scan);
  // A missing program fires "error" and maybe not "exit": whichever comes first moves on, once.
  let ended = false;
  cf.on("error", (e) => { console.log(`[tunnel] ${p.name}: cannot start ${p.cmd} (${e.message})`); onEnd(null); });
  cf.on("exit", (code) => onEnd(code));
  function onEnd(code: number | null): void {
    if (ended) return;
    ended = true;
    clearInterval(probe);
    rmSync(TUNNEL_FILE, { force: true });
    if (stopping) return void process.exit(0);
    // A tunnel that was up and dropped, or a provider that never came up: try the next one, then start over after a pause.
    const next = (i + 1) % PROVIDERS.length;
    console.log(`[tunnel] ${p.name} ${url ? "dropped" : "did not come up"} (exit ${code}); trying ${PROVIDERS[next].name}`);
    setTimeout(() => run(next), next === 0 ? 15_000 : 500);
  }
}

const stop = () => { stopping = true; rmSync(TUNNEL_FILE, { force: true }); cf?.kill(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
run(0);
