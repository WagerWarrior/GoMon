/**
 * Seeds the SYNTHETIC Northwind Platform scenario into Atlas: team, projects, members (roles, GitHub logins), policies,
 * canonical memories parsed from markdown docs (as if ingested from the team's GitHub design repo), and past meetings with
 * their locked decisions. Atlas Automated Embedding embeds memories server-side.
 *
 *   seed/company/*.md                 company-wide context (customers, production, policies, team) → projectId "company"
 *   seed/projects/<projectId>/*.md    project docs → that projectId
 *   seed/meetings/*.json              ended calls: utterances, promoted call items, locked memories, audit rows
 *   seed/other-team/*.md              a second team that proves isolation: Northwind retrieval must never return it
 *
 *   npm run seed            idempotent: inserts missing docs, never overwrites corrected/forgotten memories
 *   npm run seed -- --reset wipes all call data, memories and outbox for both teams, then reseeds (demo reset)
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ObjectId } from "mongodb";
import { config } from "../src/config.ts";
import { close, cols, connect } from "../src/db.ts";
import { BUILTIN_TEMPLATES } from "../src/templates.ts";
import { hashPassword } from "../src/auth.ts";
import { COMPANY_PROJECT } from "../src/scope.ts";
import { ITEM_KINDS, type ItemKind, type Memory } from "../src/shapes.ts";
import { writeAdr } from "../src/knowledge.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const reset = process.argv.includes("--reset");
const OTHER_TEAM = "orion-payments", OTHER_PROJECT = "payments-webhooks";

type Parsed = { key: string; kind: ItemKind; text: string; path: string };
const LINE = /^- \*\*([A-Z]-\d+)\*\* \(([a-z_]+)\): (.+)$/;

const isKind = (k: string): k is ItemKind => (ITEM_KINDS as readonly string[]).includes(k);

async function parseDir(dir: string): Promise<Parsed[]> {
  const out: Parsed[] = [];
  for (const f of (await readdir(join(ROOT, dir))).filter((n) => n.endsWith(".md")).sort()) {
    const path = relative(ROOT, join(ROOT, dir, f));
    for (const line of (await readFile(join(ROOT, path), "utf8")).split("\n")) {
      const m = LINE.exec(line.trim());
      if (!m) continue;
      if (!isKind(m[2])) throw new Error(`${path}: unknown kind "${m[2]}"`);
      out.push({ key: m[1], kind: m[2], text: m[3], path });
    }
  }
  return out;
}

/** A past call as stored in seed/meetings: utterances are [speaker, text]; locks point at utterance indexes. */
type Meeting = {
  id: string; title: string; projectId: string; startedAt: string; summary: string;
  utterances: [string, string][];
  locks: { key: string; kind: string; text: string; utterances: number[]; lockedBy: string }[];
};

const MEETINGS_DIR = join(ROOT, "seed/meetings");
const meetings: Meeting[] = await Promise.all(
  (await readdir(MEETINGS_DIR)).filter((n) => n.endsWith(".json")).sort()
    .map(async (f) => JSON.parse(await readFile(join(MEETINGS_DIR, f), "utf8")) as Meeting),
);

const { db } = await connect();
const c = cols(db);
const T = config.teamId;
const syn = { synthetic: true };

const docSets: { projectId: string; items: Parsed[] }[] = [{ projectId: COMPANY_PROJECT, items: await parseDir("seed/company") }];
for (const p of (await readdir(join(ROOT, "seed/projects"))).sort()) docSets.push({ projectId: p, items: await parseDir(`seed/projects/${p}`) });

// Keys name one memory across the whole team (scope.ts), so a duplicate anywhere in the seed is a bug.
const seen = new Map<string, string>();
const allKeys = [...docSets.flatMap((s) => s.items.map((i) => [i.key, i.path])), ...meetings.flatMap((m) => m.locks.map((l) => [l.key, m.id]))];
for (const [key, where] of allKeys) {
  if (seen.has(key)) throw new Error(`duplicate memory key ${key} in ${where} and ${seen.get(key)}`);
  seen.set(key, where);
}

if (reset) {
  const scope = { teamId: { $in: [T, OTHER_TEAM] } };
  const callIds = (await c.calls.find(scope, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id));
  const byCall = { $or: [{ callId: { $in: callIds } }, scope] };
  const results = await Promise.all([
    c.calls.deleteMany(scope), c.utterances.deleteMany(byCall), c.callItems.deleteMany(byCall), c.conflicts.deleteMany(byCall),
    c.says.deleteMany(byCall), c.agentEvents.deleteMany(byCall), c.timings.deleteMany(byCall), c.chatMessages.deleteMany(byCall),
    c.auditEvents.deleteMany(scope), c.actions.deleteMany(scope), c.memories.deleteMany(scope), c.artifacts.deleteMany(scope),
    c.counters.deleteMany({ _id: { $regex: `^(${T}|${OTHER_TEAM})/` } }),
    // Policies used to be project-scoped; they now apply team-wide (no projectId).
    c.policies.deleteMany({ ...scope, projectId: { $exists: true } }),
  ]);
  console.log(`reset: removed ${results.reduce((n, r) => n + r.deletedCount, 0)} docs for ${T} and ${OTHER_TEAM}`);
}

await c.teams.updateOne({ _id: T as never }, { $setOnInsert: { name: "Northwind Platform", ...syn } }, { upsert: true });
await c.teams.updateOne({ _id: OTHER_TEAM as never }, { $setOnInsert: { name: "Orion Payments", ...syn } }, { upsert: true });

// $set keeps names current; `github` (board link) and createdAt are never overwritten.
const projects: { _id: string; teamId: string; name: string; description: string }[] = [
  { _id: COMPANY_PROJECT, teamId: T, name: "Company context", description: "Customers, production system, standing policies and ownership; readable from every project." },
  { _id: "public-api-launch", teamId: T, name: "Public API launch", description: "Per-tenant rate limits and metering for the December 5 public API launch; Acme is the launch customer." },
  { _id: "enterprise-sso", teamId: T, name: "Enterprise SSO", description: "SAML and SCIM for Globex's renewal (end of Q1 2027), plus the EU residency question." },
  { _id: OTHER_PROJECT, teamId: OTHER_TEAM, name: "Payment webhooks", description: "Orion's webhook delivery." },
];
for (const { _id, ...p } of projects) {
  await c.projects.updateOne({ _id: _id as never }, { $set: { ...p, status: "active", ...syn }, $setOnInsert: { createdAt: new Date(), createdBy: "seed" } }, { upsert: true });
}

// Meeting display names must match what Recall/Scribe reports. Short and full names both resolve.
const members: { displayName: string; role: string; githubLogin?: string; area: string }[] = [
  { displayName: "Rob", role: "lead", githubLogin: "Roppax", area: "CTO; architecture and customer escalations" },
  { displayName: "Robert Reder", role: "lead", githubLogin: "Roppax", area: "CTO; architecture and customer escalations" },
  { displayName: "Max", role: "engineer", githubLogin: "naidx0", area: "Web dashboard and integrations" },
  { displayName: "Max Naidenov", role: "engineer", githubLogin: "naidx0", area: "Web dashboard and integrations" },
  { displayName: "Tamir", role: "engineer", githubLogin: "WagerWarrior", area: "Voice bot and meeting pipeline" },
  { displayName: "Tamir Azbel", role: "engineer", githubLogin: "WagerWarrior", area: "Voice bot and meeting pipeline" },
  { displayName: "Priya", role: "lead", area: "API gateway and rate limiting" },
  { displayName: "Marcus", role: "engineer", area: "Billing and metering pipeline" },
  { displayName: "Lena", role: "engineer", area: "Identity, auth and SSO" },
];
for (const { displayName, role, githubLogin, area } of members) {
  await c.members.updateOne(
    { teamId: T, displayName },
    { $set: { area, ...(githubLogin ? { githubLogin } : {}), ...syn }, $setOnInsert: { role } },
    { upsert: true },
  );
}
await c.members.updateOne({ teamId: OTHER_TEAM, displayName: "Ana" }, { $setOnInsert: { role: "lead", ...syn } }, { upsert: true });

// No projectId: a policy without one applies to every project of the team.
const policies: [string, string[]][] = [
  ["lock_decision", ["lead", "engineer"]], ["correct_memory", ["lead", "engineer"]], ["forget_memory", ["lead"]],
  ["create_issue", ["lead", "engineer"]], ["post_slack", ["lead", "engineer"]], ["manage_templates", ["lead"]],
  ["github_write", ["lead", "engineer"]], ["create_project", ["lead", "engineer"]], ["start_meeting", ["lead", "engineer"]],
];
for (const [action, allowedRoles] of policies) {
  await c.policies.updateOne({ teamId: T, action, projectId: { $exists: false } }, { $set: { allowedRoles, ...syn } }, { upsert: true });
}

// Users (Atlas): demo password from DEMO_PASSWORD (default "gomon-demo"); synthetic emails. displayNames map Meet names to users.
const demoPassword = process.env.DEMO_PASSWORD || "gomon-demo";
const users: { _id: string; email: string; name: string; role: string; githubLogin: string; displayNames: string[] }[] = [
  { _id: "u-rob", email: "rob@gomon.dev", name: "Robert Reder", role: "lead", githubLogin: "Roppax", displayNames: ["Robert Reder", "Rob", "Robert"] },
  { _id: "u-max", email: "max@gomon.dev", name: "Max Naidenov", role: "engineer", githubLogin: "naidx0", displayNames: ["Max Naidenov", "Max"] },
  { _id: "u-tamir", email: "tamir@gomon.dev", name: "Tamir Azbel", role: "engineer", githubLogin: "WagerWarrior", displayNames: ["Tamir Azbel", "Tamir"] },
];
for (const u of users) {
  const { _id, ...rest } = u;
  await c.users.updateOne(
    { _id: _id as never },
    { $set: { ...rest, teamId: T, displayNamesLower: u.displayNames.map((n) => n.toLowerCase()), ...syn }, $setOnInsert: { passwordHash: await hashPassword(demoPassword), createdAt: new Date() } },
    { upsert: true },
  );
}
/** Users whose Meet display names appear among a call's participants. */
function userIdsFor(participants: string[]): string[] {
  const names = participants.map((n) => n.toLowerCase());
  return users.filter((u) => u.displayNames.some((d) => names.includes(d.toLowerCase()))).map((u) => u._id);
}

for (const { _id, ...t } of BUILTIN_TEMPLATES) {
  const now = new Date();
  await c.agentTemplates.updateOne({ _id }, { $setOnInsert: { ...t, teamId: T, version: 1, createdAt: now, updatedAt: now, updatedBy: "seed", ...syn } }, { upsert: true });
}

async function seedMemories(teamId: string, projectId: string, items: Parsed[]) {
  let inserted = 0;
  for (const it of items) {
    const now = new Date();
    const doc: Omit<Memory, "_id"> = {
      teamId, projectId, key: it.key, kind: it.kind, text: it.text, status: "active", version: 1, origin: "doc",
      sourceRefs: [{ type: "doc", path: it.path }], createdAt: now, updatedAt: now, ...syn,
    };
    const r = await c.memories.updateOne({ teamId, projectId, key: it.key, origin: "doc", version: 1 }, { $setOnInsert: doc }, { upsert: true });
    inserted += r.upsertedCount;
  }
  return inserted;
}

const STEP_MS = 20_000; // seeded utterances are 20 s apart
/** One ended call with everything a real locked call leaves behind. Skipped whole if the call already exists. */
async function seedMeeting(m: Meeting): Promise<number> {
  if (await c.calls.findOne({ _id: m.id as never }, { projection: { _id: 1 } })) return 0;
  const start = new Date(m.startedAt);
  const at = (i: number) => new Date(start.getTime() + i * STEP_MS);
  const participants = [...new Set(m.utterances.map(([s]) => s))];
  const base = { callId: m.id, teamId: T, projectId: m.projectId, ...syn };

  const uttIds = m.utterances.map(() => new ObjectId());
  // processedAt set: the worker must not replay seeded utterances through the agent loop.
  await c.utterances.insertMany(m.utterances.map(([speaker, text], i) => ({
    _id: uttIds[i], ...base, seq: i + 1, sourceKey: `${m.id}-${i + 1}`, speaker: { displayName: speaker }, text, source: "typed" as const,
    startedAt: at(i), endedAt: new Date(at(i).getTime() + STEP_MS - 2_000), receivedAt: at(i), processedAt: at(i),
  })));

  for (const [n, l] of m.locks.entries()) {
    if (!isKind(l.kind)) throw new Error(`${m.id}: unknown kind "${l.kind}"`);
    const refs = l.utterances.map((i) => {
      if (!uttIds[i]) throw new Error(`${m.id} ${l.key}: no utterance ${i}`);
      return uttIds[i];
    });
    const lockedAt = new Date(at(Math.max(...l.utterances)).getTime() + 10_000 + n);
    const itemId = new ObjectId(), memoryId = new ObjectId();
    await c.callItems.insertOne({
      _id: itemId, ...base, kind: l.kind, text: l.text, status: "promoted", sourceUtteranceIds: refs,
      createdAt: at(l.utterances[0]), updatedAt: lockedAt, lockAnnouncedAt: new Date(lockedAt.getTime() - 8_000), vetoMs: 8_000,
      agreedBy: [...new Set(l.utterances.map((i) => m.utterances[i][0]))], memoryId,
    });
    const mem: Memory = {
      _id: memoryId, teamId: T, projectId: m.projectId, key: l.key, kind: l.kind, text: l.text, status: "active", version: 1, origin: "call",
      sourceRefs: [{ type: "call", callId: m.id, itemId, utteranceIds: refs }],
      lock: { lockedAt, participants, lockedBy: l.lockedBy, via: "consensus" }, createdAt: lockedAt, updatedAt: lockedAt, ...syn,
    };
    await c.memories.insertOne(mem);
    await c.auditEvents.insertOne({
      ...base, at: lockedAt, type: "memory_locked", actor: l.lockedBy, reason: "locked via consensus", ref: { itemId, memoryId, key: l.key },
    });
  }

  await c.calls.insertOne({
    _id: m.id as never, teamId: T, projectId: m.projectId, title: m.title, status: "ended", startedAt: start, endedAt: at(m.utterances.length + 2),
    participants, participantUserIds: userIdsFor(participants), ownerUserId: "u-rob", summary: m.summary,
    memoryEnabled: true, templateId: BUILTIN_TEMPLATES[0]._id, utteranceSeq: m.utterances.length, ...syn,
  });
  return m.locks.length;
}

let docCount = 0, docInserted = 0;
for (const { projectId, items } of docSets) {
  docInserted += await seedMemories(T, projectId, items);
  docCount += items.length;
}
const other = await parseDir("seed/other-team");
const otherInserted = await seedMemories(OTHER_TEAM, OTHER_PROJECT, other);
let locked = 0;
for (const m of meetings) locked += await seedMeeting(m);
// ADR artifact per locked decision (seeded past meetings and earlier calls); Atlas embeds each one (artifacts_auto, Voyage).
let adrs = 0;
for (const m of await c.memories.find({ teamId: T, status: "active", kind: "decision", origin: "call" }).toArray()) {
  if (m._id) { await writeAdr(c, { ...m, _id: m._id }); adrs++; }
}

// Backfill: existing calls get participantUserIds from their participants' display names.
for (const call of await c.calls.find({ teamId: T }, { projection: { participants: 1 } }).toArray()) {
  const ids = userIdsFor((call.participants as string[] | undefined) ?? []);
  if (ids.length) await c.calls.updateOne({ _id: call._id }, { $addToSet: { participantUserIds: { $each: ids } } });
}

// Keys are allocated per team (`${teamId}/${prefix}`); start each counter at the highest key the team already has.
const maxByPrefix = new Map<string, number>();
for (const d of await c.memories.find({ teamId: T, key: { $regex: "^[A-Z]-\\d+$" } }, { projection: { key: 1 } }).toArray()) {
  const [p, n] = String(d.key).split("-");
  maxByPrefix.set(p, Math.max(maxByPrefix.get(p) ?? 0, Number(n)));
}
for (const [p, n] of maxByPrefix) await c.counters.updateOne({ _id: `${T}/${p}` }, { $max: { n } }, { upsert: true });

console.log(`memories: +${docInserted} of ${docCount} doc memories for ${T} (${docSets.map((s) => s.projectId).join(", ")}); +${otherInserted} of ${other.length} for ${OTHER_TEAM}`);
console.log(`meetings: ${meetings.length} (+${locked} locked memories, ${adrs} ADR artifacts); counters: ${[...maxByPrefix].map(([p, n]) => `${p}-${n}`).join(" ")}`);
console.log(`projects: ${projects.length}, members: ${members.length}, policies: ${policies.length}, agent templates: ${BUILTIN_TEMPLATES.length} (all synthetic: true)`);
await close();
