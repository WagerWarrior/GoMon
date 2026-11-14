/**
 * Dev client: post typed utterances to the running worker (source "typed", never presented as live speech).
 *   npm run say -- <callId> "<speaker>" "<text>"
 *   npm run say -- <callId> --script        plays the Northwind rate-limit script with pauses (rehearsal)
 */
const [callId, a, b] = process.argv.slice(2);
const base = process.env.WORKER_URL || `http://localhost:${process.env.WORKER_PORT || 3001}`;
if (!callId || !a) {
  console.error('usage: npm run say -- <callId> "<speaker>" "<text>"   |   npm run say -- <callId> --script');
  process.exit(1);
}

async function post(speaker: string, text: string) {
  const res = await fetch(`${base}/api/utterances`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.WORKER_TOKEN ? { authorization: `Bearer ${process.env.WORKER_TOKEN}` } : {}) },
    body: JSON.stringify({ callId, speaker: { displayName: speaker }, text, source: "typed" }),
  });
  console.log(res.status, speaker, "->", text, JSON.stringify(await res.json()));
}

const SCRIPT: [string, string, number][] = [
  ["Rob", "Okay, management wants per-tenant rate limits and metering for the public API launch in three weeks.", 6000],
  ["Max", "Let's just do a flat 100 requests per second per tenant, keep it simple.", 9000],
  ["Tamir", "And we could log every request into the billing Postgres so finance gets exact usage.", 9000],
  ["Rob", "Okay so token bucket in Redis at the gateway, tiered limits, enterprise gets a 2,000 per second burst for 60 seconds, and usage goes out as async events aggregated hourly.", 7000],
  ["Max", "Agreed, let's do that.", 14000],
  ["Tamir", "Gomon, create the tickets.", 6000],
];

if (a === "--script") {
  for (const [speaker, text, pause] of SCRIPT) {
    await post(speaker, text);
    await new Promise((r) => setTimeout(r, pause));
  }
} else {
  await post(a, b ?? "");
}
