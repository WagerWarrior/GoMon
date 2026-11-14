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
