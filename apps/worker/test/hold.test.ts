import { test } from "node:test";
import assert from "node:assert/strict";
import { incompleteAsk, releaseHeld, routeAsk } from "../src/hold.ts";

test("cut-off asks from the live demo are held", () => {
  for (const t of ["Hey, Gomon. Can you tell", "Hey, Gomon.", "Hey, Gomon, in the privacy", "Cool, cool, cool. Um, hey, Gomon. Um, I'm just wondering w-",
    "Uh, so as you can see right here, uh, we're transcribing the call in real time. And what I can just do is just say, \"Hey, Gomon, um, can you like-\""]) {
    assert.equal(incompleteAsk(t), true, t);
  }
});
test("complete asks are not held", () => {
  for (const t of ["Hey, Gomon, can you hear me?", "Gomon, create the tickets.", "Gomon, lock it in.", "Hey Gomon, what's D-12?",
    "Hey, Gomon. Can you summarize D17 for me and how we can actually make a decision based on it?",
    // the question came before the name
    "Awesome. So can we actually go ahead and link this into our chat and just give us the link to the direct issue? Hey, Gomon.",
    "We wanna work through some of the issues that we have on our GitHub, specifically ticket D09. Hey, Gomon, can you take a look at"]) {
    assert.equal(incompleteAsk(t), false, t);
  }
  assert.equal(incompleteAsk("Let's go on with the plan."), false); // not addressed at all
});
test("the next sentence from the same speaker is the question", () => {
  assert.deepEqual(routeAsk("c1", "Rob", "Hey, Gomon.", 1000), { hold: true, carried: null });
  assert.deepEqual(routeAsk("c1", "Rob", "What did we decide about rate limits?", 3000), { hold: false, carried: "Hey, Gomon." });
  assert.deepEqual(routeAsk("c1", "Rob", "And another thing.", 4000), { hold: false, carried: null }); // carried once
});
test("someone else's line, or one much later, is not carried", () => {
  routeAsk("c2", "Rob", "Hey, Gomon.", 1000);
  assert.deepEqual(routeAsk("c2", "Max", "I think we should ship.", 2000), { hold: false, carried: null });
  routeAsk("c3", "Rob", "Hey, Gomon.", 1000);
  assert.deepEqual(routeAsk("c3", "Rob", "Anyway.", 30_000), { hold: false, carried: null });
});
test("a full ask right after a fragment replaces it", () => {
  routeAsk("c4", "Rob", "Uh, hey, Gom-", 1000);
  assert.deepEqual(routeAsk("c4", "Rob", "Gomon, can you summarize what this issue is about?", 2000), { hold: false, carried: null });
  assert.equal(releaseHeld("c4", "Uh, hey, Gom-", 3000, 9000), "gone");
});
test("nothing follows: the fragment is released once the room is quiet", () => {
  routeAsk("c5", "Rob", "Hey, Gomon.", 1000);
  assert.equal(releaseHeld("c5", "Hey, Gomon.", 3000, 2000), "wait");
  assert.equal(releaseHeld("c5", "Hey, Gomon.", 3000, 4500), "released");
  assert.equal(releaseHeld("c5", "Hey, Gomon.", 3000, 5000), "gone");
});

import { nameOnly, offeredAction, trailingAsk } from "../src/hold.ts";

test("name only: the name with greetings or filler, nothing to answer", () => {
  for (const t of ["Hey, Gomon.", "Gomon.", "Yes. Hey, Gomon.", "Awesome. Hey, Gomon."]) assert.equal(nameOnly(t), true, t);
  for (const t of ["Hey Gomon, what did we decide?", "Um, Max. Hey, Gomon.", "Tell me who can I assign it to? Hey, Gomon.", "What about the tickets?"]) assert.equal(nameOnly(t), false, t);
});

const NOW = 1_000_000;
test("the name after the request: what the same person just said is the ask", () => {
  // Live Nov 14: "…turn it into a GitHub issue…" / "…are you able to assign it to anybody?" / "Hey, Gomon."
  const prior = [
    { speaker: "Max", text: "Are you able to actually assign it to anybody?", at: NOW - 1000 },
    { speaker: "Max", text: "Take the ticket C02 and turn it into a GitHub issue.", at: NOW - 7000 },
  ];
  assert.deepEqual(trailingAsk(prior, "Max", 0, NOW), { ask: "Take the ticket C02 and turn it into a GitHub issue. Are you able to actually assign it to anybody?", duplicate: false });
});

test("a second name right after a line that already had the name is a duplicate, not a new ask", () => {
  // Live Nov 14: "…who can I assign it to? Hey, Gomon." then "Hey, Gomon." four seconds later: Gomon answered twice.
  const prior = [{ speaker: "Max", text: "Tell me, who can I assign it to? Hey, Gomon.", at: NOW - 4000 }];
  assert.deepEqual(trailingAsk(prior, "Max", 0, NOW), { ask: "", duplicate: true });
  assert.equal(trailingAsk([{ ...prior[0], at: NOW - 20_000 }], "Max", 0, NOW).duplicate, false, "an old addressed line is not a duplicate");
});

test("lines Gomon already answered, other people's lines and old lines are not the ask", () => {
  const line = { speaker: "Max", text: "Which tickets have nobody on them right now?", at: NOW - 5000 };
  assert.equal(trailingAsk([line], "Max", NOW - 2000, NOW).ask, "", "said before Gomon's last answer");
  assert.equal(trailingAsk([{ ...line, speaker: "Robert" }], "Max", 0, NOW).ask, "", "someone else said it");
  assert.equal(trailingAsk([{ ...line, at: NOW - 40_000 }], "Max", 0, NOW).ask, "", "too long ago");
  assert.equal(trailingAsk([{ ...line, text: "Yeah." }], "Max", 0, NOW).ask, "", "too short to be a request");
  assert.equal(trailingAsk([], "Max", 0, NOW).ask, "");
});

test("an offer to act is recognised, a plain answer is not", () => {
  assert.equal(offeredAction("Yes, I'm here. Want me to assign issue 24 to someone?"), true);
  assert.equal(offeredAction("Who should I assign issue 24 to?"), true);
  assert.equal(offeredAction("Want me to file it?"), true);
  assert.equal(offeredAction("D-17 says one global Atlas cluster. Issue 24 is unassigned."), false);
  assert.equal(offeredAction("Did you mean D-02?"), false);
});

test("spoken memory keys are written the way the records spell them", async () => {
  const { spokenKeys } = await import("../src/hold.ts");
  assert.equal(spokenKeys("Hey Gomon, what's ticket KL5?"), "Hey Gomon, what's ticket K-05?");
  assert.equal(spokenKeys("what's K5 and D17"), "what's K-05 and D-17");
  assert.equal(spokenKeys("check K 05, T-04 and KO5"), "check K-05, T-04 and K-05");
  assert.equal(spokenKeys("I have 5 tickets, a 5 minute call, issue 29"), "I have 5 tickets, a 5 minute call, issue 29");
});
