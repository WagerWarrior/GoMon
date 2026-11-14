/**
 * Collection shapes. These match apps/web/README.md ("Collection shapes this app assumes") and apps/connectors.
 * Change them only together with Max (web, connectors) and Tamir (bot page).
 */
import type { ObjectId } from "mongodb";

export const ITEM_KINDS = [
  "decision", "requirement", "constraint", "risk", "open_question", "action", "assumption", "interface", "alternative",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export type Utterance = {
  _id?: ObjectId;
  callId: string; teamId: string; projectId: string;
  seq: number;
  /** Producer-side dedup key (Recall transcript segment id, or a client-generated id). Unique per call. */
  sourceKey: string;
  speaker: { displayName: string };
  text: string;
  source: "recall" | "scribe" | "typed";
  startedAt?: Date; endedAt?: Date; receivedAt: Date;
  claimedAt?: Date; claimToken?: string; processedAt?: Date; error?: string;
};

export type CallItem = {
  _id?: ObjectId;
  callId: string; teamId: string; projectId: string;
  kind: ItemKind; text: string;
  status: "proposed" | "locking" | "promoted" | "rejected";
  sourceUtteranceIds: ObjectId[];
  createdAt: Date; updatedAt: Date;
  /** TTL: unpromoted scratch items expire. Unset on promotion. */
  expiresAt?: Date;
  lockAnnouncedAt?: Date; vetoMs?: number; agreedBy?: string[];
  memoryId?: ObjectId;
};

export type SourceRef =
  | { type: "doc"; path: string }
  | { type: "call"; callId: string; itemId?: ObjectId; utteranceIds: ObjectId[] };

export type Memory = {
  _id?: ObjectId;
  teamId: string; projectId: string;
  key?: string;
  kind: ItemKind; text: string;
  status: "active" | "superseded" | "forgotten";
  version: number;
  supersedes?: ObjectId; supersededBy?: ObjectId;
  origin: "call" | "doc";
  sourceRefs: SourceRef[];
  lock?: { lockedAt: Date; participants: string[]; lockedBy: string; via: "consensus" | "human" | "voice" };
  createdAt: Date; updatedAt: Date;
  forgottenAt?: Date; forgottenBy?: string;
  synthetic?: boolean;
};

export type Conflict = {
  _id?: ObjectId;
  callId: string; teamId: string; projectId: string;
  itemId: ObjectId; memoryId: ObjectId; memoryKey?: string;
  severity: "high" | "medium" | "low";
  kind: "conflict" | "already_decided";
  spoken: boolean; note: string; createdAt: Date;
};

export type Say = {
  _id?: ObjectId;
  sayId: string;
  callId: string; teamId: string; projectId: string;
  text: string;
  priority: "high" | "normal";
  reason: "addressed" | "conflict" | "already_decided" | "lock_announce" | "lock_vetoed" | "lock_done" | "suggestion" | "command";
  status: "queued" | "started" | "done" | "failed" | "cancelled";
  createdAt: Date; updatedAt: Date;
  utteranceId?: ObjectId;
  /** ElevenLabs voice from the call's agent template; the bot page falls back to ELEVENLABS_VOICE_ID when absent. */
  voiceId?: string;
};

export type AuditEvent = {
  callId?: string; teamId: string; projectId: string;
  at: Date; type: string; actor: string; reason: string; ref?: Record<string, unknown>;
};

/**
 * Agent template: how Gomon behaves on a call. A call points at one with `calls.templateId`; the worker loads it per batch.
 * proactivity: quiet = speaks only when addressed; balanced = one high-severity conflict per batch + rare suggestions;
 * active = conflicts plus more frequent suggestions. consensus: announce_veto = "Locking in…" with a veto window;
 * explicit_only = locks only on "lock it in" or a human click.
 */
export type AgentTemplate = {
  _id: string;
  teamId: string;
  name: string;
  description: string;
  persona: string;
  proactivity: "quiet" | "balanced" | "active";
  consensus: "announce_veto" | "explicit_only";
  vetoMs: number;
  captureKinds: ItemKind[];
  voiceId?: string;
  version: number;
  createdAt: Date; updatedAt: Date; updatedBy: string;
  synthetic?: boolean;
};
