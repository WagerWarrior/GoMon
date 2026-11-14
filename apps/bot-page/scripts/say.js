// Dev helper: make Gomon speak without the worker.
// Usage: npm run say -- "Locking in: tiered token-bucket limits." [normal|high] [callId]
// With a callId (or SAY_CALL_ID) only that call's bot page speaks; without one every open page does.
const [text, priority = "normal", callId = process.env.SAY_CALL_ID] = process.argv.slice(2);
if (!text) { console.error('usage: npm run say -- "text" [high]'); process.exit(1); }
const port = process.env.BOT_PAGE_PORT || 8787;
const headers = { "content-type": "application/json" };
if (process.env.SAY_TOKEN) headers.authorization = `Bearer ${process.env.SAY_TOKEN}`;
const r = await fetch(`http://localhost:${port}/say`, { method: "POST", headers, body: JSON.stringify({ text, priority, ...(callId ? { callId } : {}) }) });
console.log(r.status, await r.text());
