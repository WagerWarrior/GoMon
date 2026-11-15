import { test } from "node:test";
import assert from "node:assert/strict";
import { parseParticipantEvent, rollCall, eventsAuthorized } from "../src/roster.ts";

// Payload shape per Recall real-time events (participant_events.join / .leave), the same envelope as transcript.data.
const ev = (event: string, participant: Record<string, unknown>, botId = "bot-1") => ({
  event,
  data: {
    data: { participant: { is_host: false, platform: "google_meet", extra_data: {}, email: null, ...participant }, timestamp: { absolute: "2026-11-15T00:10:00Z", relative: 3.2 }, action: event.split(".")[1] },
    realtime_endpoint: { id: "re-1", metadata: {} }, participant_events: { id: "pe-1", metadata: {} }, recording: { id: "rec-1", metadata: {} }, bot: { id: botId, metadata: {} },
  },
});

test("a join and a leave come out as who, which way, from which bot", () => {
  assert.deepEqual(parseParticipantEvent(ev("participant_events.join", { id: 100, name: "Max Naidenov" })), { kind: "join", id: "100", name: "Max Naidenov", botId: "bot-1" });
  assert.deepEqual(parseParticipantEvent(ev("participant_events.leave", { id: 100, name: "Max Naidenov" })), { kind: "leave", id: "100", name: "Max Naidenov", botId: "bot-1" });
});

test("Gomon itself, nameless entries, other event types and junk are ignored", () => {
  assert.equal(parseParticipantEvent(ev("participant_events.join", { id: 1, name: "Gomon" })), null);
  assert.equal(parseParticipantEvent(ev("participant_events.join", { id: 2, name: "  " })), null);
  assert.equal(parseParticipantEvent(ev("participant_events.join", { id: 3, name: null })), null);
  assert.equal(parseParticipantEvent(ev("transcript.data", { id: 4, name: "Rob" })), null);
  assert.equal(parseParticipantEvent(null), null);
  assert.equal(parseParticipantEvent({ event: "participant_events.join" }), null);
});

test("the roll call names everyone once, in join order", () => {
  assert.equal(rollCall(["Max Naidenov", "Robert Reder", "Max Naidenov"]), "Gomon here. In this call: Max Naidenov and Robert Reder.");
  assert.equal(rollCall(["Max Naidenov", "Robert Reder", "Tamir Azbel"]), "Gomon here. In this call: Max Naidenov, Robert Reder and Tamir Azbel.");
  assert.equal(rollCall(["Max Naidenov"]), "Gomon here. In this call: Max Naidenov.");
  assert.equal(rollCall([]), "Gomon here. Nobody else is in this call yet.");
});

test("events are accepted only with the webhook token; no token configured means nothing is accepted", () => {
  assert.equal(eventsAuthorized("s3cret", "s3cret"), true);
  assert.equal(eventsAuthorized("wrong", "s3cret"), false);
  assert.equal(eventsAuthorized(null, "s3cret"), false);
  assert.equal(eventsAuthorized("", ""), false);
});

test("Gomon's context names who is in the Meet when the live list exists, else who has spoken", async () => {
  const { peopleLine } = await import("../src/platform.ts");
  const spoke = [{ name: "Max Naidenov", role: "engineer", github: "naidx0" }];
  assert.match(peopleLine({ inCall: ["Max Naidenov", "Robert Reder"], participants: spoke }), /^IN THIS CALL NOW \(from Google Meet's participant list, live\): Max Naidenov, Robert Reder\./);
  assert.match(peopleLine({ inCall: [], participants: spoke }), /IN THIS CALL NOW .*: nobody besides you\./);
  assert.match(peopleLine({ inCall: null, participants: spoke }), /^PEOPLE WHO HAVE SPOKEN ON THIS CALL: Max Naidenov \(engineer\)\./);
});
