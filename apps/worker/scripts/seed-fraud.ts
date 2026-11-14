/**
 * Demo scenario (Max, Nov 14): a bank fraud case from a past client meeting, with its tickets, to check on in a live call.
 * Adds one past meeting ("Meridian Bank fraud review", Nov 11), the memories it locked, and their GitHub issues: two
 * assigned, three with nobody on them, one already closed. Company context, so every project's call can read it.
 * Safe to run twice: the meeting and each issue are created only if missing.   npm run seed:fraud
 */
import { ObjectId } from "mongodb";
import { connect, cols, close } from "../src/db.ts";
import { config } from "../src/config.ts";
import { BUILTIN_TEMPLATES } from "../src/templates.ts";

const T = config.teamId, P = "company", CALL = "seed-2026-11-11-meridian-fraud-review";
const syn = { synthetic: true };
const [ROB, MAX, TAMIR] = ["Robert Reder", "Max Naidenov", "Tamir Azbel"];
const UTT: [string, string][] = [
  [ROB, "Meridian Bank opened fraud case FR-2291 with us on Monday. One of their API keys leaked and was used for card testing against the public API."],
  [TAMIR, "The logs show about 4,200 card-testing calls from that key on November 9. Thirty-seven of them went through before the key was revoked."],
  [ROB, "Their contract says a suspected-fraud case is acknowledged within one hour and resolved or escalated within five business days. That puts the deadline at November 18."],
  [MAX, "So for FR-2291: rotate the leaked key, refund the 37 fraudulent charges, and add a per-key velocity limit before we close the case."],
  [TAMIR, "Agreed. I can add the velocity limit in the gateway: at most 20 failed authorizations a minute per API key."],
  [ROB, "Agreed. The key was revoked and rotated on the day, that part is done. Somebody still has to send Meridian the written incident report."],
  [MAX, "And the refunds need an owner. I also want a fraud panel on the dashboard: failed authorizations per API key, per minute."],
  [ROB, "Good. Nobody has picked up the report, the refunds or the panel yet. We check where this stands in the next review."],
];
type Lock = { key: string; kind: "decision" | "requirement" | "risk" | "action"; text: string; utt: number[]; by: string; issue?: { assignee?: string; closed?: boolean } };
const LOCKS: Lock[] = [
  { key: "K-05", kind: "risk", by: TAMIR, utt: [0, 1], text: "Fraud case FR-2291 (Meridian Bank): a leaked API key was used for about 4,200 card-testing calls on November 9, 2026; 37 charges went through before the key was revoked." },
  { key: "R-17", kind: "requirement", by: ROB, utt: [2], text: "Meridian Bank's contract: a suspected-fraud case is acknowledged within 1 hour and resolved or escalated within 5 business days; for FR-2291 that is November 18, 2026." },
  { key: "D-18", kind: "decision", by: MAX, utt: [3, 4, 5], text: "Fraud case FR-2291 closes only when three things are done: the leaked key is rotated, the 37 fraudulent charges are refunded, and a per-key velocity limit is live in the gateway.", issue: { assignee: "Roppax" } },
  { key: "T-04", kind: "action", by: TAMIR, utt: [4], text: "Tamir adds a per-key velocity limit to the gateway for fraud case FR-2291: at most 20 failed authorizations a minute per API key.", issue: { assignee: "WagerWarrior" } },
  { key: "T-05", kind: "action", by: ROB, utt: [5], text: "Send Meridian Bank the written incident report for fraud case FR-2291 (what leaked, the 4,200 calls, the 37 charges, what changes).", issue: {} },
  { key: "T-06", kind: "action", by: MAX, utt: [6], text: "Refund the 37 fraudulent charges on Meridian Bank's tenant from fraud case FR-2291 and confirm the amounts with their finance contact.", issue: {} },
  { key: "T-07", kind: "action", by: MAX, utt: [6], text: "Add a fraud panel to the dashboard for fraud case FR-2291 follow-up: failed authorizations per API key, per minute, with an alert at 20.", issue: {} },
  { key: "T-08", kind: "action", by: ROB, utt: [5], text: "Revoke and rotate Meridian Bank's leaked API key from fraud case FR-2291 (done on November 9, 2026).", issue: { assignee: "Roppax", closed: true } },
];
const SUMMARY = "Meridian Bank fraud review (client case FR-2291). A leaked Meridian API key was used for about 4,200 card-testing calls on November 9; 37 charges went through (K-05). The contract gives five business days, so the case must be resolved or escalated by November 18 (R-17). Locked D-18: the case closes when the key is rotated, the 37 charges are refunded and a per-key velocity limit is live. Tickets: T-08 rotate the key (done), T-04 velocity limit (Tamir), T-05 incident report to Meridian, T-06 refunds, T-07 dashboard fraud panel. The report, the refunds and the panel had no owner when the meeting ended.";

const { db } = await connect(); const c = cols(db);
if (await c.calls.findOne({ _id: CALL as never }, { projection: { _id: 1 } })) console.log(`meeting ${CALL} is already there`);
else {
  const taken = await c.memories.find({ teamId: T, key: { $in: LOCKS.map((l) => l.key) } }).project({ key: 1 }).toArray();
  if (taken.length) throw new Error(`keys already used: ${taken.map((m) => m.key).join(", ")}`);
  const start = new Date("2026-11-11T16:00:00Z"), STEP = 20_000;
  const at = (i: number) => new Date(start.getTime() + i * STEP);
  const base = { callId: CALL, teamId: T, projectId: P, ...syn };
  const ids = UTT.map(() => new ObjectId());
  await c.utterances.insertMany(UTT.map(([speaker, text], i) => ({
    _id: ids[i], ...base, seq: i + 1, sourceKey: `${CALL}-${i + 1}`, speaker: { displayName: speaker }, text, source: "typed" as const,
    startedAt: at(i), endedAt: new Date(at(i).getTime() + STEP - 2000), receivedAt: at(i), processedAt: at(i),
  })));
  for (const [n, l] of LOCKS.entries()) {
    const refs = l.utt.map((i) => ids[i]);
    const lockedAt = new Date(at(Math.max(...l.utt)).getTime() + 10_000 + n);
    const itemId = new ObjectId(), memoryId = new ObjectId();
    await c.callItems.insertOne({
      _id: itemId, ...base, kind: l.kind, text: l.text, status: "promoted", sourceUtteranceIds: refs,
      createdAt: at(l.utt[0]), updatedAt: lockedAt, lockAnnouncedAt: new Date(lockedAt.getTime() - 8000), vetoMs: 8000,
      agreedBy: [...new Set(l.utt.map((i) => UTT[i][0]))], memoryId,
    } as never);
    await c.memories.insertOne({
      _id: memoryId, teamId: T, projectId: P, key: l.key, kind: l.kind, text: l.text, status: "active", version: 1, origin: "call",
      sourceRefs: [{ type: "call", callId: CALL, itemId, utteranceIds: refs }],
      lock: { lockedAt, participants: [ROB, MAX, TAMIR], lockedBy: l.by, via: "consensus" }, createdAt: lockedAt, updatedAt: lockedAt, ...syn,
    } as never);
    await c.auditEvents.insertOne({ ...base, at: lockedAt, type: "memory_locked", actor: l.by, reason: "locked via consensus", ref: { itemId, memoryId, key: l.key } } as never);
  }
  await c.calls.insertOne({
    _id: CALL as never, teamId: T, projectId: P, title: "Meridian Bank fraud review", status: "ended", startedAt: start, endedAt: at(UTT.length + 2),
    participants: [ROB, MAX, TAMIR], participantUserIds: ["u-rob", "u-max", "u-tamir"], ownerUserId: "u-rob", summary: SUMMARY,
    memoryEnabled: true, templateId: BUILTIN_TEMPLATES[0]._id, utteranceSeq: UTT.length, ...syn,
  } as never);
  console.log(`meeting added with ${UTT.length} lines and ${LOCKS.length} locked memories: ${LOCKS.map((l) => l.key).join(", ")}`);
}

// GitHub issues, one per ticket memory, created only if no issue with that title exists yet.
const repo = process.env.GITHUB_REPO || "WagerWarrior/MongoDB", token = process.env.GITHUB_TOKEN;
if (!token) console.log("GITHUB_TOKEN is not set: no issues created");
else {
  const gh = (path: string, init: RequestInit = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" } });
  const existing = (await (await gh("/issues?state=all&per_page=100")).json()) as { number: number; title: string }[];
  // Each seeded issue is also recorded as a filing of its memory (an `actions` row), the way a live filing is. Without it the
  // "already filed?" check found nothing, so "Hey Gomon, file T-05" would have opened a second issue next to #29.
  const record = async (l: Lock, n: number) => {
    const mem = await c.memories.findOne({ teamId: T, key: l.key, status: "active" }, { projection: { _id: 1 } });
    if (!mem) return;
    await c.actions.updateOne({ idempotencyKey: `seed-fraud:${l.key}` }, { $setOnInsert: {
      type: "github", teamId: T, projectId: P, payload: { op: "create_issue", title: `${l.key}: seeded issue #${n}` }, requestedBy: "seed-fraud",
      idempotencyKey: `seed-fraud:${l.key}`, status: "confirmed", attempts: 1, createdAt: new Date(), announce: false,
      policyCheck: { allowed: true, reason: "demo issue created by scripts/seed-fraud.ts with the repo token", checkedAt: new Date() },
      externalId: `${repo}#${n}`, externalUrl: `https://github.com/${repo}/issues/${n}`, memoryId: mem._id, ...syn,
    } } as never, { upsert: true });
  };
  for (const l of LOCKS.filter((x) => x.issue)) {
    const title = `${l.key}: ${l.text.length > 110 ? `${l.text.slice(0, 109)}…` : l.text}`;
    const had = existing.find((i) => i.title.startsWith(`${l.key}: `) && i.title.includes("FR-2291"));
    if (had) { await record(l, had.number); console.log(`issue #${had.number} already there for ${l.key} (filing recorded)`); continue; }
    const res = await gh("/issues", { method: "POST", body: JSON.stringify({
      title, labels: ["gomon", l.kind],
      body: `${l.text}\n\nFrom the meeting "Meridian Bank fraud review" (November 11, 2026), locked as ${l.key} by ${l.by}. Client case FR-2291. Demo data (synthetic).`,
      ...(l.issue?.assignee ? { assignees: [l.issue.assignee] } : {}),
    }) });
    const made = (await res.json()) as { number?: number; message?: string };
    if (!res.ok || !made.number) { console.log(`issue for ${l.key} failed: ${res.status} ${made.message ?? ""}`); continue; }
    if (l.issue?.closed) await gh(`/issues/${made.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
    await record(l, made.number);
    console.log(`issue #${made.number} ${l.issue?.closed ? "(closed) " : ""}for ${l.key}${l.issue?.assignee ? `, assigned to ${l.issue.assignee}` : ", nobody assigned"}`);
  }
}
await close();
