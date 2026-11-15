import { test } from "node:test";
import assert from "node:assert/strict";
import { parseParticipantEvent, rollCall, eventsAuthorized, meetName, SpeechTimeline } from "../src/roster.ts";
import type { Person } from "../src/people.ts";

// Payload shape per Recall real-time events (participant_events.join / .leave), the same envelope as transcript.data.
const ev = (event: string, participant: Record<string, unknown>, botId = "bot-1") => ({
  event,
  data: {
    data: { participant: { is_host: false, platform: "google_meet", extra_data: {}, email: null, ...participant }, timestamp: { absolute: "2026-11-15T00:10:00Z", relative: 3.2 }, action: event.split(".")[1] },
    realtime_endpoint: { id: "re-1", metadata: {} }, participant_events: { id: "pe-1", metadata: {} }, recording: { id: "rec-1", metadata: {} }, bot: { id: botId, metadata: {} },
  },
});

test("a join and a leave come out as who, which way, from which bot", () => {
  const at = Date.parse("2026-11-15T00:10:00Z");
  assert.deepEqual(parseParticipantEvent(ev("participant_events.join", { id: 100, name: "Max Naidenov" })), { kind: "join", id: "100", name: "Max Naidenov", botId: "bot-1", at });
  assert.deepEqual(parseParticipantEvent(ev("participant_events.leave", { id: 100, name: "Max Naidenov" })), { kind: "leave", id: "100", name: "Max Naidenov", botId: "bot-1", at });
  assert.deepEqual(parseParticipantEvent(ev("participant_events.speech_on", { id: 100, name: "Max Naidenov" })), { kind: "speech_on", id: "100", name: "Max Naidenov", botId: "bot-1", at });
  assert.deepEqual(parseParticipantEvent(ev("participant_events.speech_off", { id: 100, name: "Max Naidenov" })), { kind: "speech_off", id: "100", name: "Max Naidenov", botId: "bot-1", at });
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

// Live, Nov 15: Robert joined the Meet as "Robert"; the team knows him as Robert Reder (GitHub Roppax).
const team: Person[] = [
  { display: "Max Naidenov", login: "naidx0", names: ["max naidenov", "max"] },
  { display: "Robert Reder", login: "Roppax", names: ["robert reder", "robert", "rob"] },
  { display: "Tamir Azbel", login: "WagerWarrior", names: ["tamir azbel", "tamir"] },
];

test("a Meet name is matched to the team member it names; a stranger keeps the name Meet shows", () => {
  assert.equal(meetName("Robert", team), "Robert Reder");
  assert.equal(meetName("max naidenov", team), "Max Naidenov");
  assert.equal(meetName("Lena Park", team), "Lena Park");
  assert.equal(meetName("Robert", []), "Robert");
});

test("the speech timeline gives each line to whoever was talking while it was said", async () => {
  const { speakerFor } = await import("../src/speakers.ts");
  const t = new SpeechTimeline();
  const t0 = 1_000_000;
  t.on("101", "Robert Reder", t0);
  t.off("101", t0 + 3000);
  t.on("100", "Max Naidenov", t0 + 5000);
  // Robert's three-second turn, committed by Scribe a second after he stopped.
  assert.equal(speakerFor(t.spans(t0 + 4000), t0 + 4000, 8), "Robert Reder");
  // Max is still talking (an open span counts up to now).
  assert.equal(speakerFor(t.spans(t0 + 8000), t0 + 8000, 6), "Max Naidenov");
  // A second speech_on for someone already talking does not restart them; an off for someone silent is ignored.
  t.on("100", "Max Naidenov", t0 + 6000);
  t.off("999", t0 + 6000);
  assert.equal(t.spans(t0 + 8000).filter((s) => s.name === "Max Naidenov").length, 1);
});

test("old speech is forgotten, so nothing grows without bound", () => {
  const t = new SpeechTimeline(60_000);
  t.on("1", "A", 0); t.off("1", 1000);
  t.on("2", "B", 100_000); t.off("2", 101_000);
  assert.deepEqual(t.spans(102_000).map((s) => s.name), ["B"]);
});

test("a line takes the live speaker's name and keeps the label it was heard under; no live speaker leaves it as heard", async () => {
  const { labelLine } = await import("../src/roster.ts");
  assert.deepEqual(labelLine("Max Naidenov", "Robert Reder"), { displayName: "Robert Reder", heardAs: "Max Naidenov" });
  assert.deepEqual(labelLine("Max Naidenov", "Max Naidenov"), { displayName: "Max Naidenov" });
  assert.deepEqual(labelLine("Max Naidenov", null), { displayName: "Max Naidenov" });
});
