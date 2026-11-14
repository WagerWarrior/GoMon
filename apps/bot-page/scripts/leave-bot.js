// Take a Gomon bot out of its meeting. Usage: npm run leave-bot -- <botId>
const [botId] = process.argv.slice(2);
const { RECALL_API_KEY, RECALL_REGION = "us-west-2" } = process.env;
if (!botId || !RECALL_API_KEY) { console.error("usage: npm run leave-bot -- <botId>   (RECALL_API_KEY in .env)"); process.exit(1); }
const r = await fetch(`https://${RECALL_REGION}.recall.ai/api/v1/bot/${botId}/leave_call/`, {
  method: "POST", headers: { authorization: `Token ${RECALL_API_KEY}`, accept: "application/json" },
});
const text = await r.text();
if (!r.ok) { console.error(`Recall ${r.status}: ${text}`); process.exit(1); }
console.log(`bot ${botId} is leaving the call`);
