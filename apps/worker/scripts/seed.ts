/**
 * Seeds SYNTHETIC team context into Atlas: teams, members (roles), policies, and canonical memories parsed from
 * seed/context/*.md (as if ingested from the team's GitHub design repo). Atlas Automated Embedding embeds them server-side.
 * A second team (seed/other-team) proves isolation: Northwind retrieval must never return it.
 *
 *   npm run seed            idempotent: inserts missing docs, never overwrites corrected/forgotten memories
 *   npm run seed -- --reset wipes this project's call data and restores the seeded memories (demo reset)
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { config } from "../src/config.ts";
import { close, cols, connect } from "../src/db.ts";
import { BUILTIN_TEMPLATES } from "../src/templates.ts";
import { hashPassword } from "../src/auth.ts";
import { ITEM_KINDS, type ItemKind, type Memory } from "../src/shapes.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const reset = process.argv.includes("--reset");
const OTHER_TEAM = "orion-payments", OTHER_PROJECT = "payments-webhooks";

type Parsed = { key: string; kind: ItemKind; text: string; path: string };
const LINE = /^- \*\*([A-Z]-\d+)\*\* \(([a-z_]+)\): (.+)$/;

async function parseDir(dir: string): Promise<Parsed[]> {
  const out: Parsed[] = [];
  for (const f of (await readdir(join(ROOT, dir))).filter((n) => n.endsWith(".md")).sort()) {
    const path = relative(ROOT, join(ROOT, dir, f));
    for (const line of (await readFile(join(ROOT, path), "utf8")).split("\n")) {
      const m = LINE.exec(line.trim());
      if (!m) continue;
      if (!(ITEM_KINDS as readonly string[]).includes(m[2])) throw new Error(`${path}: unknown kind "${m[2]}"`);
      out.push({ key: m[1], kind: m[2] as ItemKind, text: m[3], path });
    }
  }
  return out;
}

const { db } = await connect();
const c = cols(db);
const T = config.teamId, P = config.projectId;
const syn = { synthetic: true };

if (reset) {
  const scope = { teamId: { $in: [T, OTHER_TEAM] } };
  const callIds = (await c.calls.find(scope, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id));
  const byCall = { callId: { $in: callIds } };
  const results = await Promise.all([
    c.calls.deleteMany(scope), c.utterances.deleteMany(byCall), c.callItems.deleteMany(byCall), c.conflicts.deleteMany(byCall),
    c.says.deleteMany(byCall), c.agentEvents.deleteMany(byCall), c.timings.deleteMany(byCall),
    c.auditEvents.deleteMany(scope), c.actions.deleteMany(scope), c.memories.deleteMany(scope),
    c.counters.deleteMany({ _id: { $regex: `^(${T}|${OTHER_TEAM})/` } }),
  ]);
  console.log(`reset: removed ${results.reduce((n, r) => n + r.deletedCount, 0)} docs for ${T} and ${OTHER_TEAM}`);
}

await c.teams.updateOne({ _id: T as never }, { $setOnInsert: { name: "Northwind Platform", ...syn } }, { upsert: true });
await c.teams.updateOne({ _id: OTHER_TEAM as never }, { $setOnInsert: { name: "Orion Payments", ...syn } }, { upsert: true });
await c.projects.updateOne({ _id: P as never }, { $setOnInsert: { teamId: T, name: "Public API launch", ...syn } }, { upsert: true });
await c.projects.updateOne({ _id: OTHER_PROJECT as never }, { $setOnInsert: { teamId: OTHER_TEAM, name: "Payment webhooks", ...syn } }, { upsert: true });

// Meeting display names must match what Recall/Scribe reports. Short and full names both resolve.
const members: [string, string][] = [
  ["Rob", "lead"], ["Robert Reder", "lead"], ["Max", "engineer"], ["Max Naidenov", "engineer"],
  ["Tamir", "engineer"], ["Tamir Azbel", "engineer"], ["Priya", "lead"], ["Marcus", "engineer"], ["Lena", "engineer"],
];
for (const [displayName, role] of members) {
  await c.members.updateOne({ teamId: T, displayName }, { $setOnInsert: { role, ...syn } }, { upsert: true });
}
await c.members.updateOne({ teamId: OTHER_TEAM, displayName: "Ana" }, { $setOnInsert: { role: "lead", ...syn } }, { upsert: true });

const policies: [string, string[]][] = [
  ["lock_decision", ["lead", "engineer"]], ["correct_memory", ["lead", "engineer"]], ["forget_memory", ["lead"]],
  ["create_issue", ["lead", "engineer"]], ["post_slack", ["lead", "engineer"]], ["manage_templates", ["lead"]],
];
for (const [action, allowedRoles] of policies) {
  await c.policies.updateOne({ teamId: T, projectId: P, action }, { $set: { allowedRoles, ...syn } }, { upsert: true });
}

// Users (Atlas): demo password from DEMO_PASSWORD (default "gomon-demo"); synthetic emails. displayNames map Meet names to users.
const demoPassword = process.env.DEMO_PASSWORD || "gomon-demo";
const users: { _id: string; email: string; name: string; role: string; displayNames: string[] }[] = [
  { _id: "u-rob", email: "rob@gomon.dev", name: "Robert Reder", role: "lead", displayNames: ["Robert Reder", "Rob", "Robert"] },
  { _id: "u-max", email: "max@gomon.dev", name: "Max Naidenov", role: "engineer", displayNames: ["Max Naidenov", "Max"] },
  { _id: "u-tamir", email: "tamir@gomon.dev", name: "Tamir Azbel", role: "engineer", displayNames: ["Tamir Azbel", "Tamir"] },
];
for (const u of users) {
  const { _id, ...rest } = u;
  await c.users.updateOne(
    { _id: _id as never },
    { $set: { ...rest, teamId: T, displayNamesLower: u.displayNames.map((n) => n.toLowerCase()), ...syn }, $setOnInsert: { passwordHash: await hashPassword(demoPassword), createdAt: new Date() } },
    { upsert: true },
  );
}
// Backfill: existing calls get participantUserIds from their participants' display names.
for (const call of await c.calls.find({ teamId: T }, { projection: { participants: 1 } }).toArray()) {
  const names = ((call.participants as string[] | undefined) ?? []).map((n) => n.toLowerCase());
  const ids = users.filter((u) => u.displayNames.some((d) => names.includes(d.toLowerCase()))).map((u) => u._id);
  if (ids.length) await c.calls.updateOne({ _id: call._id }, { $addToSet: { participantUserIds: { $each: ids } } });
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

const mine = await parseDir("seed/context");
const other = await parseDir("seed/other-team");
console.log(`memories: +${await seedMemories(T, P, mine)} of ${mine.length} for ${T}/${P}; +${await seedMemories(OTHER_TEAM, OTHER_PROJECT, other)} of ${other.length} for ${OTHER_TEAM}`);
console.log(`members: ${members.length}, policies: ${policies.length}, agent templates: ${BUILTIN_TEMPLATES.length} (all synthetic: true)`);
await close();
