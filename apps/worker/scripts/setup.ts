/**
 * Creates the Gomon schema on Atlas: collections with validators, indexes (incl. TTL and unique), and the
 * Vector Search + Atlas Search indexes on `memories`. Idempotent; safe to re-run.
 *   npm run setup
 */
import type { Db, Document } from "mongodb";
import { config, INDEX } from "../src/config.ts";
import { close, connect } from "../src/db.ts";
import { ITEM_KINDS } from "../src/shapes.ts";

/** An active decision locked on a call must carry its lock proof and sources (spec section 6). */
const memoriesValidator: Document = {
  $and: [
    {
      $jsonSchema: {
        bsonType: "object",
        required: ["teamId", "projectId", "kind", "text", "status", "version", "origin", "sourceRefs"],
        properties: {
          teamId: { bsonType: "string" },
          projectId: { bsonType: "string" },
          kind: { enum: [...ITEM_KINDS] },
          text: { bsonType: "string", minLength: 1 },
          status: { enum: ["active", "superseded", "forgotten"] },
          version: { bsonType: ["int", "long", "double"], minimum: 1 },
          origin: { enum: ["call", "doc"] },
          sourceRefs: { bsonType: "array", minItems: 1 },
        },
      },
    },
    {
      $or: [
        { origin: { $ne: "call" } },
        { status: { $ne: "active" } },
        {
          "lock.lockedAt": { $type: "date" },
          "lock.participants.0": { $exists: true },
          "lock.lockedBy": { $type: "string" },
        },
      ],
    },
  ],
};

/** Same rule apps/connectors tests against: nothing is "sent" without a passing policy check and an external ID. */
const actionsValidator: Document = {
  $or: [
    { status: { $nin: ["sent", "confirmed"] } },
    { $and: [{ "policyCheck.allowed": true }, { requestedBy: { $type: "string" } }, { externalId: { $type: "string" } }] },
  ],
};

const callItemsValidator: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["callId", "teamId", "projectId", "kind", "text", "status", "sourceUtteranceIds"],
    properties: {
      kind: { enum: [...ITEM_KINDS] },
      status: { enum: ["proposed", "locking", "promoted", "rejected"] },
      sourceUtteranceIds: { bsonType: "array" },
    },
  },
};

async function ensureCollection(db: Db, name: string, validator?: Document) {
  const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) {
    await db.createCollection(name, validator ? { validator, validationAction: "error", validationLevel: "strict" } : {});
    console.log(`created ${name}${validator ? " (validator)" : ""}`);
    return;
  }
  if (validator) {
    try {
      await db.command({ collMod: name, validator, validationAction: "error", validationLevel: "strict" });
      console.log(`updated validator on ${name}`);
    } catch (e: any) {
      console.warn(`could not update validator on existing ${name} (${e.codeName ?? e.message}); drop it and re-run to apply`);
    }
  }
}

async function ensureSearchIndex(db: Db, coll: string, name: string, type: "search" | "vectorSearch", definition: Document) {
  const c = db.collection(coll);
  const existing = await c.listSearchIndexes(name).toArray();
  if (existing.length) {
    await c.updateSearchIndex(name, definition);
    console.log(`updated ${type} index ${coll}.${name}`);
  } else {
    await c.createSearchIndex({ name, type, definition });
    console.log(`created ${type} index ${coll}.${name}`);
  }
}

async function waitQueryable(db: Db, coll: string, names: string[], timeoutMs = 180_000) {
  const start = Date.now();
  for (;;) {
    const idx = await db.collection(coll).listSearchIndexes().toArray();
    const pending = names.filter((n) => !idx.find((i: any) => i.name === n && i.queryable));
    if (!pending.length) return console.log(`search indexes queryable: ${names.join(", ")}`);
    if (Date.now() - start > timeoutMs) return console.warn(`still building after ${timeoutMs / 1000}s: ${pending.join(", ")}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const { db } = await connect();
console.log(`Atlas ${(await db.admin().command({ buildInfo: 1 })).version}, database "${config.dbName}"`);

await ensureCollection(db, "memories", memoriesValidator);
await ensureCollection(db, "actions", actionsValidator);
await ensureCollection(db, "call_items", callItemsValidator);
await ensureCollection(db, "agent_templates", {
  $jsonSchema: {
    bsonType: "object",
    required: ["teamId", "name", "persona", "proactivity", "consensus", "vetoMs", "captureKinds", "version"],
    properties: {
      name: { bsonType: "string", minLength: 1, maxLength: 60 },
      persona: { bsonType: "string", maxLength: 600 },
      proactivity: { enum: ["quiet", "balanced", "active"] },
      consensus: { enum: ["announce_veto", "explicit_only"] },
      vetoMs: { bsonType: ["int", "long", "double"], minimum: 3000, maximum: 60000 },
      captureKinds: { bsonType: "array", minItems: 1, items: { enum: [...ITEM_KINDS] } },
    },
  },
});
for (const n of ["teams", "projects", "members", "policies", "calls", "utterances", "conflicts", "audit_events",
  "agent_events", "timings", "says", "counters", "stream_offsets"]) await ensureCollection(db, n);

const ix = (coll: string, spec: Document, opts: Document = {}) => db.collection(coll).createIndex(spec, opts);
await Promise.all([
  ix("members", { teamId: 1, displayName: 1 }, { unique: true }),
  ix("agent_templates", { teamId: 1, name: 1 }, { unique: true }),
  ix("policies", { teamId: 1, projectId: 1, action: 1 }),
  ix("utterances", { callId: 1, sourceKey: 1 }, { unique: true }),
  ix("utterances", { callId: 1, seq: 1 }),
  ix("utterances", { processedAt: 1, receivedAt: 1 }),
  ix("utterances", { callId: 1, processedAt: 1, claimedAt: 1, seq: 1 }),
  ix("utterances", { claimToken: 1 }, { sparse: true }),
  ix("call_items", { callId: 1, status: 1, createdAt: 1 }),
  ix("call_items", { expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ix("memories", { teamId: 1, projectId: 1, status: 1, kind: 1 }),
  ix("memories", { teamId: 1, projectId: 1, key: 1, version: -1 }),
  ix("memories", { teamId: 1, projectId: 1, status: 1, updatedAt: -1 }),
  ix("conflicts", { callId: 1, itemId: 1, memoryId: 1 }, { unique: true }),
  ix("actions", { idempotencyKey: 1 }, { unique: true }),
  ix("actions", { externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } }),
  ix("actions", { status: 1, nextAttemptAt: 1 }),
  ix("audit_events", { teamId: 1, projectId: 1, at: -1 }),
  ix("audit_events", { callId: 1, at: -1 }),
  ix("agent_events", { callId: 1, at: -1 }),
  ix("timings", { callId: 1, stage: 1, at: -1 }),
  ix("says", { callId: 1, status: 1, createdAt: 1 }),
  ix("says", { sayId: 1 }, { unique: true }),
]);
console.log("indexes ensured (incl. TTL on call_items.expiresAt, unique utterance/action/conflict keys)");

// Atlas Automated Embedding: Atlas embeds `text` with Voyage at index time and the query string at query time.
await ensureSearchIndex(db, "memories", INDEX.vector, "vectorSearch", {
  fields: [
    { type: "autoEmbed", modality: "text", path: "text", model: config.embedModel },
    { type: "filter", path: "teamId" },
    { type: "filter", path: "projectId" },
    { type: "filter", path: "status" },
    { type: "filter", path: "kind" },
    { type: "filter", path: "origin" },
  ],
});
if ((await db.collection("memories").listSearchIndexes("memories_vector").toArray()).length) {
  await db.collection("memories").dropSearchIndex("memories_vector");
  console.log("dropped legacy client-embedding index memories.memories_vector");
}
await ensureSearchIndex(db, "memories", INDEX.text, "search", {
  mappings: {
    dynamic: false,
    fields: {
      text: { type: "string", analyzer: "lucene.english" },
      key: { type: "string", analyzer: "lucene.standard" },
      teamId: { type: "token" },
      projectId: { type: "token" },
      status: { type: "token" },
      kind: { type: "token" },
    },
  },
});
await waitQueryable(db, "memories", [INDEX.vector, INDEX.text]);
await close();
